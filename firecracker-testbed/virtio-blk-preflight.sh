#!/usr/bin/env bash
# RED-258 preflight — virtio-blk drive + label-based mount check.
#
# Answers the two preflight questions the RED-258 ticket opens with
# before any impl work starts:
#
#   1. Can a labeled ext4 image be attached to a guest VM as a second
#      virtio-blk drive AND read from successfully?
#
#   2. Does `/dev/disk/by-label/<label>` populate inside the reference
#      rootfs? If yes, the agent can mount allowlist drives by label
#      (path-stable regardless of drive-attach order). If no, the
#      fallback is mount-by-device-node (`/dev/vdb`, `/dev/vdc`, ...)
#      using attach-order metadata in the ExecRequest.
#
# The "ext4 in the reference kernel" question answers itself: the
# rootfs is ext4, so the kernel has `CONFIG_EXT4_FS=y`. We don't
# re-verify that here.
#
# Flow:
#
#   1. Build a tiny test ext4 image with `mke2fs -d` + label
#      `CAMBIUMPREFL` + a sentinel file.
#   2. Boot Firecracker with rootfs at /dev/vda AND the test drive at
#      /dev/vdb.
#   3. Send one ExecRequest to the agent with a JS program that:
#      - lists /dev/disk/by-label/ (populated or not?)
#      - lists /dev/vd* (sanity: is vdb there?)
#      - tries mount by label, then by device node
#      - cats the sentinel
#   4. Report which mount path(s) work and whether the sentinel reads.
#
# Runs on the same environment as smoke.sh v1 (kernel + rootfs
# artifacts at ./kernel/vmlinux and ./rootfs/out/rootfs.ext4, or via
# CAMBIUM_FC_KERNEL / CAMBIUM_FC_ROOTFS overrides).

set -eo pipefail

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${CAMBIUM_FC_KERNEL:-${HERE}/kernel/vmlinux}"
ROOTFS="${CAMBIUM_FC_ROOTFS:-${HERE}/rootfs/out/rootfs.ext4}"

WORKDIR=$(mktemp -d -t cambium-preflight-XXXXXX)
API_SOCK="${WORKDIR}/fc.api.sock"
VSOCK_UDS="${WORKDIR}/fc.vsock.sock"
STAGED_ROOTFS="${WORKDIR}/rootfs.ext4"
STAGED_TEST="${WORKDIR}/test.ext4"
TEST_SRC_DIR="${WORKDIR}/test-src"
FC_LOG="${WORKDIR}/fc.log"
GUEST_CID=3
VSOCK_PORT=52717
LABEL="CAMBIUMPREFL"
SENTINEL="hello from a virtio-blk-attached ext4 image ($$)"
EXT4_BUILDER_IMAGE="${EXT4_BUILDER_IMAGE:-cambium-ext4-builder:latest}"

FC_PID=""
cleanup() {
  if [ -n "${FC_PID}" ]; then
    kill "${FC_PID}" 2>/dev/null || true
    wait "${FC_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# ── Preflight on the host itself ────────────────────────────────────
info "RED-258 preflight — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  host arch:    %s\n' "$(uname -m)"
printf '  firecracker:  %s\n' "$(firecracker --version | head -n1)"
printf '  kernel:       %s\n' "${KERNEL}"
printf '  rootfs:       %s\n' "${ROOTFS}"
printf '  test label:   %s\n' "${LABEL}"

[ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "/dev/kvm not accessible (need root or kvm group membership)"
[ -f "${KERNEL}" ] || fail "kernel missing: ${KERNEL}"
[ -f "${ROOTFS}" ] || fail "rootfs missing: ${ROOTFS}"
command -v firecracker >/dev/null || fail "firecracker not on PATH"
command -v python3 >/dev/null || fail "python3 not on PATH"

# ── Build the test ext4 image ───────────────────────────────────────
info "Building test ext4 image with label '${LABEL}'"
mkdir -p "${TEST_SRC_DIR}"
printf '%s\n' "${SENTINEL}" > "${TEST_SRC_DIR}/sentinel"

# Use the existing ext4-builder helper — same pattern rootfs/build.sh
# uses. Build the helper image if it doesn't exist yet.
if ! docker image inspect "${EXT4_BUILDER_IMAGE}" >/dev/null 2>&1; then
  info "Building ext4-builder helper image"
  docker build --platform "${PLATFORM:-linux/arm64}" --quiet \
    -t "${EXT4_BUILDER_IMAGE}" "${HERE}/rootfs/ext4-builder" >/dev/null
fi

# mke2fs -d needs a sized target; 8 MB is comfortably bigger than
# the metadata + sentinel content we put in there. For real allowlists
# the substrate will size by content.
docker run --rm \
  --platform "${PLATFORM:-linux/arm64}" \
  -v "${TEST_SRC_DIR}:/src:ro" \
  -v "${WORKDIR}:/out" \
  --entrypoint /bin/sh \
  "${EXT4_BUILDER_IMAGE}" \
  -c "mke2fs -q -t ext4 -d /src -L ${LABEL} /out/test.ext4 8M" \
  || fail "mke2fs failed to build the test ext4 image"

[ -f "${STAGED_TEST}" ] || fail "test.ext4 wasn't produced"
pass "test ext4 built: $(du -h "${STAGED_TEST}" | cut -f1)"

# Stage the rootfs into the workdir (Firecracker needs read-write access,
# host mount may be read-only; same pattern smoke.sh v1 uses).
cp "${ROOTFS}" "${STAGED_ROOTFS}"

# ── Firecracker API helpers ─────────────────────────────────────────
FC_RESP="${WORKDIR}/fc-resp"
api_put() {
  local path="$1" body="$2"
  curl -s -o "${FC_RESP}" -w '%{http_code}' \
    -X PUT --unix-socket "${API_SOCK}" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    "http://localhost${path}" -d "${body}"
}
expect_204() {
  local code="$1" path="$2"
  if [ "${code}" != "204" ]; then
    echo "    API ${path} returned ${code}:"
    [ -s "${FC_RESP}" ] && sed 's/^/      /' "${FC_RESP}"
    echo "    firecracker log tail:"
    tail -n 40 "${FC_LOG}" 2>/dev/null | sed 's/^/      /'
    fail "${path} failed"
  fi
}

# ── Boot the VM with rootfs + test drive ────────────────────────────
info "Booting VM: rootfs at /dev/vda, test ext4 at /dev/vdb"
rm -f "${API_SOCK}" "${VSOCK_UDS}" "${FC_LOG}"
firecracker --api-sock "${API_SOCK}" >"${FC_LOG}" 2>&1 &
FC_PID=$!
for i in $(seq 1 50); do
  [ -S "${API_SOCK}" ] && break
  sleep 0.1
done
[ -S "${API_SOCK}" ] || fail "Firecracker API socket did not appear"

HTTP=$(api_put /machine-config '{"vcpu_count":1,"mem_size_mib":512}'); expect_204 "${HTTP}" /machine-config
HTTP=$(api_put /boot-source "$(cat <<JSON
{"kernel_image_path":"${KERNEL}","boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/usr/local/bin/cambium-agent"}
JSON
)"); expect_204 "${HTTP}" /boot-source

HTTP=$(api_put /drives/rootfs "$(cat <<JSON
{"drive_id":"rootfs","path_on_host":"${STAGED_ROOTFS}","is_root_device":true,"is_read_only":false}
JSON
)"); expect_204 "${HTTP}" /drives/rootfs

# The second drive — this is the RED-258-relevant bit.
HTTP=$(api_put /drives/test "$(cat <<JSON
{"drive_id":"test","path_on_host":"${STAGED_TEST}","is_root_device":false,"is_read_only":true}
JSON
)"); expect_204 "${HTTP}" /drives/test

HTTP=$(api_put /vsock "$(cat <<JSON
{"vsock_id":"vsock0","guest_cid":${GUEST_CID},"uds_path":"${VSOCK_UDS}"}
JSON
)"); expect_204 "${HTTP}" /vsock

HTTP=$(api_put /actions '{"action_type":"InstanceStart"}'); expect_204 "${HTTP}" /actions
pass "VM started with two drives attached"

# ── Probe the guest ─────────────────────────────────────────────────
info "Probing guest — asking the agent to inspect the extra drive"

PROBE_SCRIPT="${WORKDIR}/probe.py"
cat > "${PROBE_SCRIPT}" <<'PYEOF'
import json, os, socket, struct, sys, time

UDS = sys.argv[1]
PORT = int(sys.argv[2])

# Dial + CONNECT (same handshake fc_vsock_probe.py uses).
deadline = time.monotonic() + 20
last_err = None
sock = None
while time.monotonic() < deadline:
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        sock.connect(UDS)
        sock.sendall(f"CONNECT {PORT}\n".encode())
        line = bytearray()
        while True:
            b = sock.recv(1)
            if not b:
                raise EOFError("eof before newline")
            line.extend(b)
            if b == b"\n":
                break
        text = bytes(line).decode("ascii", errors="replace").strip()
        if not text.startswith("OK "):
            raise RuntimeError(f"rejected: {text!r}")
        break
    except Exception as e:
        last_err = e
        if sock is not None:
            try: sock.close()
            except: pass
        time.sleep(0.5)
else:
    print(f"[probe] could not dial: {last_err!r}", file=sys.stderr)
    sys.exit(2)

# Send ExecRequest — JS program that runs a shell pipeline probing
# all the paths the agent might later use to mount allowlist drives.
code = r"""
const { execSync } = require('child_process');
let out;
try {
  out = execSync([
    'echo "--- /dev/disk/by-label/ CONTENTS ---"',
    '(ls -la /dev/disk/by-label/ 2>&1 && echo "BY_LABEL_DIR_EXISTS") || echo "BY_LABEL_DIR_MISSING"',
    'echo "--- /dev/vd* ---"',
    'ls -la /dev/vd* 2>&1',
    'echo "--- blkid ---"',
    'blkid 2>&1 || echo "(blkid unavailable)"',
    'echo "--- mount by label (ext4 explicit) ---"',
    'mkdir -p /mnt/testlabel',
    'mount -t ext4 /dev/disk/by-label/CAMBIUMPREFL /mnt/testlabel 2>&1 && echo "MOUNTED_BY_LABEL" || echo "FAILED_BY_LABEL"',
    'cat /mnt/testlabel/sentinel 2>&1 | sed "s/^/LABEL_READ: /"',
    'umount /mnt/testlabel 2>/dev/null',
    'echo "--- mount by device (ext4 explicit) ---"',
    'mkdir -p /mnt/testdev',
    'mount -t ext4 /dev/vdb /mnt/testdev 2>&1 && echo "MOUNTED_BY_DEV" || echo "FAILED_BY_DEV"',
    'cat /mnt/testdev/sentinel 2>&1 | sed "s/^/DEV_READ: /"',
    'umount /mnt/testdev 2>/dev/null',
    'echo "--- /etc/filesystems + /proc/filesystems ---"',
    'cat /etc/filesystems 2>&1 || echo "(no /etc/filesystems)"',
    'echo "---"',
    'grep -E "ext4|ext3|ext2" /proc/filesystems 2>&1',
  ].join(' ; '), { shell: '/bin/sh' }).toString();
} catch (e) {
  out = 'EXEC ERROR: ' + (e.stderr?.toString() || e.message);
}
console.log(out);
"""

req = {
    "language": "js",
    "code": code,
    "cpu": 1.0,
    "memory_mb": 512,
    "timeout_seconds": 30,
    "max_output_bytes": 200_000,
}
body = json.dumps(req).encode("utf-8")
sock.sendall(struct.pack(">I", len(body)) + body)

# Read one ExecResponse.
hdr = b""
while len(hdr) < 4:
    chunk = sock.recv(4 - len(hdr))
    if not chunk:
        raise EOFError("eof reading response header")
    hdr += chunk
(resp_len,) = struct.unpack(">I", hdr)
resp_body = b""
while len(resp_body) < resp_len:
    chunk = sock.recv(resp_len - len(resp_body))
    if not chunk:
        raise EOFError("eof reading response body")
    resp_body += chunk

resp = json.loads(resp_body.decode("utf-8"))
print(f"[probe] status: {resp.get('status')}  exit_code: {resp.get('exit_code')}")
print("[probe] stdout:")
print(resp.get("stdout", ""))
if resp.get("stderr"):
    print("[probe] stderr:")
    print(resp.get("stderr"))
PYEOF
chmod +x "${PROBE_SCRIPT}"

if ! OUT=$(python3 "${PROBE_SCRIPT}" "${VSOCK_UDS}" "${VSOCK_PORT}" 2>&1); then
  echo "${OUT}"
  echo
  echo "firecracker log tail:"
  tail -n 40 "${FC_LOG}" 2>/dev/null | sed 's/^/  /'
  fail "probe failed to complete"
fi
echo "${OUT}"

# ── Parse + report ──────────────────────────────────────────────────
info "Findings"

by_label_populated=false
label_mount_works=false
dev_mount_works=false
label_read_works=false
dev_read_works=false

# Check for the explicit marker the probe emits — not just the label
# string, which would false-positive on the mount error line.
if echo "${OUT}" | grep -q "BY_LABEL_DIR_EXISTS"; then
  by_label_populated=true
fi
if echo "${OUT}" | grep -q "MOUNTED_BY_LABEL"; then
  label_mount_works=true
fi
if echo "${OUT}" | grep -q "MOUNTED_BY_DEV"; then
  dev_mount_works=true
fi
if echo "${OUT}" | grep -q "LABEL_READ: ${SENTINEL}"; then
  label_read_works=true
fi
if echo "${OUT}" | grep -q "DEV_READ: ${SENTINEL}"; then
  dev_read_works=true
fi

if ${by_label_populated}; then
  pass "/dev/disk/by-label/${LABEL} is present"
else
  warn "/dev/disk/by-label/ does NOT contain ${LABEL} (fallback: mount by device node)"
fi

if ${label_mount_works}; then
  pass "mount-by-label works"
elif ${dev_mount_works}; then
  warn "mount-by-device works (but not by-label; impl should use device-order metadata)"
else
  fail "neither mount path worked — virtio-blk drive attach may be broken"
fi

if ${label_read_works} || ${dev_read_works}; then
  pass "sentinel readable from mounted ext4 image"
else
  fail "sentinel not readable — mount succeeded but content is wrong"
fi

echo
info "Conclusion"
if ${label_mount_works} && ${label_read_works}; then
  printf '  \033[32mGREEN\033[0m  Agent can use label-based mounts (/dev/disk/by-label/<label>).\n'
  printf '         RED-258 impl proceeds with label-based mounting as designed.\n'
elif ${dev_mount_works} && ${dev_read_works}; then
  printf '  \033[33mYELLOW\033[0m  Label-based mounts unavailable; fallback to device-node order works.\n'
  printf '          RED-258 impl needs to carry drive-order metadata in ExecRequest.mounts\n'
  printf '          instead of label metadata. Small adjustment; same ticket scope.\n'
else
  printf '  \033[31mRED\033[0m    Neither mount path works. RED-258 needs a different approach.\n'
fi

echo
echo "Raw probe output is above. Workdir cleaned up on exit."
