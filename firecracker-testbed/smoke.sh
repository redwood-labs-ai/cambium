#!/usr/bin/env bash
# Firecracker smoke test (RED-251 / RED-255).
#
# v0 (checks 1–3): floor — KVM accessible, firecracker installed,
# API socket responds. Runs unconditionally.
#
# v1 (checks 4–5): integration — boot a real microVM with a real
# rootfs, establish a vsock connection, round-trip one ExecRequest
# against the cambium-agent, validate the response. Runs only when
# artifacts are present under /artifacts/ (mounted by the compose
# file). Skipped with a clear hint if not.
#
# Exits non-zero on any FAIL. SKIP does not fail.

set -eo pipefail

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Global cleanup — covers check 3 AND check 4/5 state. Everything is
# idempotent/optional-checked so the trap is safe regardless of how
# far we got.
FC_PID=""
API_SOCK=""
VSOCK_UDS=""
FC_LOG=""
cleanup() {
  if [ -n "${FC_PID}" ]; then
    kill "${FC_PID}" 2>/dev/null || true
  fi
  [ -n "${API_SOCK}" ] && rm -f "${API_SOCK}"
  if [ -n "${VSOCK_UDS}" ]; then
    rm -f "${VSOCK_UDS}" "${VSOCK_UDS}"_*
  fi
}
trap cleanup EXIT

info "Firecracker testbed smoke — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  host arch:    %s\n' "$(uname -m)"
printf '  kernel:       %s\n' "$(uname -r)"

# ── Check 1: /dev/kvm accessible ─────────────────────────────────────
info "Check 1 — /dev/kvm accessible"
if [ -c /dev/kvm ]; then
  ls -l /dev/kvm
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    pass "/dev/kvm is a char device and readable+writable"
  else
    fail "/dev/kvm exists but is NOT readable+writable (perms: $(stat -c %a /dev/kvm)). Container likely missing KVM group access."
  fi
else
  fail "/dev/kvm missing inside container. Check compose --device passthrough."
fi

# ── Check 2: firecracker binary present ──────────────────────────────
info "Check 2 — firecracker binary invocable"
if command -v firecracker >/dev/null; then
  firecracker --version
  pass "firecracker binary found on PATH"
else
  fail "firecracker binary not on PATH"
fi

# ── Check 3: Firecracker API socket responds ─────────────────────────
info "Check 3 — Firecracker API socket starts and responds"
API_SOCK=/tmp/fc-smoke.sock
rm -f "${API_SOCK}"

firecracker --api-sock "${API_SOCK}" &
FC_PID=$!

# Wait up to 5 seconds for the socket to appear.
for i in $(seq 1 50); do
  [ -S "${API_SOCK}" ] && break
  sleep 0.1
done

if [ ! -S "${API_SOCK}" ]; then
  fail "Firecracker API socket did not appear at ${API_SOCK} after 5s"
fi
pass "API socket appeared at ${API_SOCK}"

# GET /machine-config on a fresh firecracker returns an empty machine
# config — proves the API loop is alive. Any 2xx response is the signal
# we care about; the JSON body itself isn't interesting at this stage.
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --unix-socket "${API_SOCK}" \
  "http://localhost/machine-config")

if [ "${HTTP_CODE}" = "200" ]; then
  pass "Firecracker API responded (GET /machine-config → ${HTTP_CODE})"
else
  fail "Firecracker API returned unexpected status: ${HTTP_CODE}"
fi

# Done with the floor-check firecracker — tear it down so check 4
# spawns a fresh one with full VM config.
kill "${FC_PID}" 2>/dev/null || true
wait "${FC_PID}" 2>/dev/null || true
FC_PID=""
rm -f "${API_SOCK}"
API_SOCK=""

# ── Check 4: microVM boots from kernel + rootfs ──────────────────────
info "Check 4 — microVM boot with kernel + rootfs"

KERNEL=/artifacts/kernel/vmlinux
ROOTFS=/artifacts/rootfs/rootfs.ext4

if [ ! -f "${KERNEL}" ] || [ ! -f "${ROOTFS}" ]; then
  skip "artifacts missing"
  echo "    expected: ${KERNEL}"
  echo "    expected: ${ROOTFS}"
  echo "    build them from the repo host (outside this container):"
  echo "      cd firecracker-testbed/kernel  && ./fetch.sh"
  echo "      cd firecracker-testbed/rootfs  && ./build.sh"
  echo "    they land in ./kernel/vmlinux and ./rootfs/out/rootfs.ext4,"
  echo "    which docker-compose.yml mounts into /artifacts/ here."
  info "v0 checks passed. v1 integration skipped — see hint above."
  exit 0
fi

printf '  kernel:       %s (%s)\n' "${KERNEL}" "$(du -h "${KERNEL}" | cut -f1)"
printf '  rootfs:       %s (%s)\n' "${ROOTFS}" "$(du -h "${ROOTFS}" | cut -f1)"

# Stage the rootfs into /tmp so the guest can write to its own
# filesystem. The /artifacts mount is read-only (so smoke runs
# never dirty the source artifact on the host), but Firecracker
# opens drive files O_RDWR when is_read_only is false — that
# call would hit EROFS against a read-only bind mount. Copying
# to /tmp gives the guest a writable copy scoped to this run.
# Kernel is never written to; no staging needed for vmlinux.
STAGED_ROOTFS=/tmp/rootfs.ext4
cp "${ROOTFS}" "${STAGED_ROOTFS}"
ROOTFS="${STAGED_ROOTFS}"

API_SOCK=/tmp/fc-boot.sock
VSOCK_UDS=/tmp/fc-vsock.sock
FC_LOG=/tmp/fc.log
rm -f "${API_SOCK}" "${VSOCK_UDS}" "${VSOCK_UDS}"_* "${FC_LOG}"

# Background firecracker with stdout/stderr captured so we can dump
# them on failure. Kernel console output (console=ttyS0) lands here.
firecracker --api-sock "${API_SOCK}" >"${FC_LOG}" 2>&1 &
FC_PID=$!

for i in $(seq 1 50); do
  [ -S "${API_SOCK}" ] && break
  sleep 0.1
done
[ -S "${API_SOCK}" ] || fail "boot Firecracker API socket did not appear at ${API_SOCK}"

# Tiny helper to PUT JSON to the FC API and capture status + body.
# Firecracker returns 204 No Content on successful mutation.
FC_RESP=/tmp/fc-resp
api_put() {
  local path="$1" body="$2"
  curl -s -o "${FC_RESP}" -w '%{http_code}' \
    -X PUT \
    --unix-socket "${API_SOCK}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    "http://localhost${path}" \
    -d "${body}"
}
expect_204() {
  local path="$1" code="$2"
  if [ "${code}" != "204" ]; then
    echo "    API ${path} returned ${code}:"
    [ -s "${FC_RESP}" ] && sed 's/^/      /' "${FC_RESP}"
    echo "    firecracker log tail:"
    tail -n 40 "${FC_LOG}" 2>/dev/null | sed 's/^/      /'
    fail "Firecracker API call failed: ${path}"
  fi
}

# 1/4 machine-config: 1 vCPU, 512 MB RAM — enough for Alpine +
# python/node runtime with comfortable headroom. Default (128 MB)
# is too tight once we start running real interpreters.
HTTP=$(api_put /machine-config '{"vcpu_count":1,"mem_size_mib":512}')
expect_204 /machine-config "${HTTP}"

# 2/4 boot-source: kernel + cmdline. `init=` points at our agent so
# the kernel skips busybox init entirely and runs cambium-agent
# as PID 1. `console=ttyS0` sends kernel messages to FC_LOG.
HTTP=$(api_put /boot-source "$(cat <<JSON
{
  "kernel_image_path": "${KERNEL}",
  "boot_args": "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/usr/local/bin/cambium-agent"
}
JSON
)")
expect_204 /boot-source "${HTTP}"

# 3/4 rootfs drive: first virtio-blk, hence /dev/vda from the kernel
# cmdline. Read-write because /tmp (and other scratch dirs used by
# interpreters) lives on the rootfs in v1 — no tmpfs overlay yet.
HTTP=$(api_put /drives/rootfs "$(cat <<JSON
{
  "drive_id": "rootfs",
  "path_on_host": "${ROOTFS}",
  "is_root_device": true,
  "is_read_only": false
}
JSON
)")
expect_204 /drives/rootfs "${HTTP}"

# 4/4 vsock device: guest CID 3 (2 is reserved for host), parent UDS
# at VSOCK_UDS. Host-initiated connections go through this UDS with
# a `CONNECT <port>\n` handshake — the probe script handles that.
HTTP=$(api_put /vsock "$(cat <<JSON
{
  "vsock_id": "vsock0",
  "guest_cid": 3,
  "uds_path": "${VSOCK_UDS}"
}
JSON
)")
expect_204 /vsock "${HTTP}"

# Start the VM.
HTTP=$(api_put /actions '{"action_type":"InstanceStart"}')
expect_204 /actions "${HTTP}"

pass "microVM started (InstanceStart 204)"

# ── Check 5: vsock round-trip with the guest agent ───────────────────
info "Check 5 — vsock round-trip to cambium-agent"

if FC_VSOCK_UDS="${VSOCK_UDS}" python3 /testbed/fc_vsock_probe.py; then
  pass "agent round-trip completed and matched expected output"
else
  PROBE_STATUS=$?
  echo "    probe exit: ${PROBE_STATUS}"
  echo "    firecracker log tail:"
  tail -n 60 "${FC_LOG}" 2>/dev/null | sed 's/^/      /'
  fail "vsock round-trip did not complete successfully"
fi

info "All checks passed — Firecracker substrate floor + integration solid."
echo
echo "Next integration steps (follow-ups):"
echo "  - host-side FirecrackerSubstrate (TS) — talks this exact protocol"
echo "  - snapshot / restore lifecycle for warm-start"
echo "  - RED-250 escape-test matrix run against this substrate"
