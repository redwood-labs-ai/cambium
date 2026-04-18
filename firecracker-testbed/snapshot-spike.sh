#!/usr/bin/env bash
# RED-256 snapshot/restore latency spike.
#
# Answers the single biggest open question in RED-256:
#
#   After `PATCH /vm Resumed` returns 204, how long until the host can
#   complete a CONNECT handshake against the guest's restored
#   vsock-accept()? I.e., does the guest agent's accept() wake
#   correctly on the first post-resume dial, or does it need bounded
#   retry?
#
# The answer determines whether the production snapshot/restore path
# can hit the RED-256 target of <50 ms p95 warm-restore + handshake,
# or whether it needs retry-with-backoff that eats the latency budget.
#
# Flow:
#
#   1. Build template (ONCE):
#      - Spawn firecracker, drive through full config + InstanceStart.
#      - Probe the agent via vsock to confirm it's in accept(), close
#        that probe connection cleanly (agent loops back to accept).
#      - Pause via PATCH /vm, snapshot via PUT /snapshot/create.
#      - Tear down firecracker; keep memfile + snapshot on disk.
#
#   2. Restore loop (N times):
#      - Spawn fresh firecracker.
#      - PUT /snapshot/load with shared-mmap File backend.
#      - PATCH /vm Resumed; dial the parent UDS and measure
#        elapsed-ms from "we started dialling" to "OK <port> received".
#      - Destroy firecracker, unlink UDS.
#
#   3. Report p50/p95/min/max/success-rate across N iterations.
#
# Requires the same environment as smoke.sh v1: Linux+KVM,
# firecracker v1.10.x on PATH, kernel + rootfs artifacts at
# /artifacts/kernel/vmlinux and /artifacts/rootfs/rootfs.ext4
# (OR provide paths via env vars below).
#
# Run as root (or from a user in the kvm group). On the MS-R1:
#
#   cd ~/cambium/firecracker-testbed
#   sudo ./snapshot-spike.sh

set -eo pipefail

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── Config ──────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${CAMBIUM_FC_KERNEL:-${HERE}/kernel/vmlinux}"
ROOTFS="${CAMBIUM_FC_ROOTFS:-${HERE}/rootfs/out/rootfs.ext4}"
ITERATIONS="${SPIKE_ITERATIONS:-100}"
GUEST_CID=3
VSOCK_PORT=52717

WORKDIR=$(mktemp -d -t cambium-spike-XXXXXX)
API_SOCK="${WORKDIR}/fc.api.sock"
VSOCK_UDS="${WORKDIR}/fc.vsock.sock"
STAGED_ROOTFS="${WORKDIR}/rootfs.ext4"
MEMFILE="${WORKDIR}/memfile.img"
SNAPFILE="${WORKDIR}/snapshot.bin"
FC_LOG="${WORKDIR}/fc.log"
MEASUREMENTS="${WORKDIR}/measurements.txt"

FC_PID=""
cleanup() {
  if [ -n "${FC_PID}" ]; then
    kill "${FC_PID}" 2>/dev/null || true
    wait "${FC_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# ── Preflight ───────────────────────────────────────────────────────
info "RED-256 snapshot/restore spike — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  host arch:    %s\n' "$(uname -m)"
printf '  firecracker:  %s\n' "$(firecracker --version | head -n1)"
printf '  kernel:       %s\n' "${KERNEL}"
printf '  rootfs:       %s\n' "${ROOTFS}"
printf '  iterations:   %s\n' "${ITERATIONS}"
printf '  workdir:      %s\n' "${WORKDIR}"

[ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "/dev/kvm not accessible (need root or kvm group membership)"
[ -f "${KERNEL}" ] || fail "kernel missing: ${KERNEL}"
[ -f "${ROOTFS}" ] || fail "rootfs missing: ${ROOTFS}"
command -v firecracker >/dev/null || fail "firecracker not on PATH"
command -v python3 >/dev/null || fail "python3 not on PATH"

# Stage the rootfs once — restored VMs share it as their virtio-blk
# source, so it needs to persist across iterations.
cp "${ROOTFS}" "${STAGED_ROOTFS}"

# ── API helpers ─────────────────────────────────────────────────────
FC_RESP="${WORKDIR}/fc-resp"
api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "${body}" ]; then
    curl -s -o "${FC_RESP}" -w '%{http_code}' \
      -X "${method}" --unix-socket "${API_SOCK}" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      "http://localhost${path}" -d "${body}"
  else
    curl -s -o "${FC_RESP}" -w '%{http_code}' \
      -X "${method}" --unix-socket "${API_SOCK}" \
      -H 'Accept: application/json' \
      "http://localhost${path}"
  fi
}

expect_status() {
  local want="$1" got="$2" path="$3"
  if [ "${got}" != "${want}" ]; then
    echo "    API ${path} returned ${got}, wanted ${want}:"
    [ -s "${FC_RESP}" ] && sed 's/^/      /' "${FC_RESP}"
    echo "    firecracker log tail:"
    tail -n 40 "${FC_LOG}" 2>/dev/null | sed 's/^/      /'
    fail "API call failed: ${path}"
  fi
}

wait_for_socket() {
  local path="$1" deadline=$(( $(date +%s) + 5 ))
  while [ ! -S "${path}" ]; do
    [ "$(date +%s)" -ge "${deadline}" ] && fail "socket did not appear at ${path} within 5s"
    sleep 0.05
  done
}

spawn_firecracker() {
  rm -f "${API_SOCK}" "${VSOCK_UDS}"
  firecracker --api-sock "${API_SOCK}" >"${FC_LOG}" 2>&1 &
  FC_PID=$!
  wait_for_socket "${API_SOCK}"
}

kill_firecracker() {
  if [ -n "${FC_PID}" ]; then
    kill "${FC_PID}" 2>/dev/null || true
    wait "${FC_PID}" 2>/dev/null || true
    FC_PID=""
  fi
  rm -f "${API_SOCK}" "${VSOCK_UDS}" "${VSOCK_UDS}"_*
}

# ── Inline Python probe ─────────────────────────────────────────────
# Tight-poll dial+handshake. Emits a single line with elapsed-ms from
# probe start to OK receipt. stderr carries any failure context.
PROBE_SCRIPT="${WORKDIR}/spike_probe.py"
cat > "${PROBE_SCRIPT}" <<'PYEOF'
import os, socket, struct, sys, time

UDS = sys.argv[1]
PORT = int(sys.argv[2])
TIMEOUT_MS = int(os.environ.get("SPIKE_TIMEOUT_MS", "5000"))
# Tight poll interval; we want to measure true first-success latency
# rather than be granularity-bounded by a longer sleep.
POLL_INTERVAL_S = 0.001

t0 = time.monotonic_ns()
deadline_ns = t0 + TIMEOUT_MS * 1_000_000
last_err = None

while time.monotonic_ns() < deadline_ns:
    s = None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(UDS)
        s.sendall(f"CONNECT {PORT}\n".encode())
        line = bytearray()
        while True:
            b = s.recv(1)
            if not b:
                raise EOFError("eof before newline")
            line.extend(b)
            if b == b"\n":
                break
            if len(line) > 128:
                raise ValueError("line too long")
        text = bytes(line).decode("ascii", errors="replace").strip()
        if not text.startswith("OK "):
            raise RuntimeError(f"rejected: {text!r}")
        t1 = time.monotonic_ns()
        elapsed_ms = (t1 - t0) / 1_000_000
        # Machine-readable single-line output: ELAPSED_MS\n
        print(f"{elapsed_ms:.3f}")
        s.close()
        sys.exit(0)
    except (FileNotFoundError, ConnectionRefusedError, EOFError,
            RuntimeError, ValueError, socket.timeout, OSError) as e:
        last_err = e
        if s is not None:
            try: s.close()
            except OSError: pass
        time.sleep(POLL_INTERVAL_S)

print(f"TIMEOUT last_err={last_err!r}", file=sys.stderr)
sys.exit(1)
PYEOF
chmod +x "${PROBE_SCRIPT}"

# ── Template build ──────────────────────────────────────────────────
info "Building template snapshot"
spawn_firecracker

CODE=$(api PUT /machine-config '{"vcpu_count":1,"mem_size_mib":512}')
expect_status 204 "${CODE}" /machine-config
CODE=$(api PUT /boot-source "$(cat <<JSON
{"kernel_image_path": "${KERNEL}", "boot_args": "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/usr/local/bin/cambium-agent"}
JSON
)")
expect_status 204 "${CODE}" /boot-source
CODE=$(api PUT /drives/rootfs "$(cat <<JSON
{"drive_id":"rootfs","path_on_host":"${STAGED_ROOTFS}","is_root_device":true,"is_read_only":false}
JSON
)")
expect_status 204 "${CODE}" /drives/rootfs
CODE=$(api PUT /vsock "$(cat <<JSON
{"vsock_id":"vsock0","guest_cid":${GUEST_CID},"uds_path":"${VSOCK_UDS}"}
JSON
)")
expect_status 204 "${CODE}" /vsock
CODE=$(api PUT /actions '{"action_type":"InstanceStart"}')
expect_status 204 "${CODE}" /actions
pass "VM booted"

# Confirm agent is in accept() by dialing once and getting OK back.
# Uses a generous timeout since this is cold-boot-to-first-listen.
info "Confirming agent is listening"
if ! SPIKE_TIMEOUT_MS=20000 python3 "${PROBE_SCRIPT}" "${VSOCK_UDS}" "${VSOCK_PORT}" >/dev/null 2>&1; then
  fail "agent never came up — check rootfs + kernel + init= cmdline"
fi
pass "agent responded to CONNECT"

# Give the agent a fraction of a second to return from the handshake
# handler and loop back to accept() before we snapshot. Without this
# the snapshot could capture mid-handler state.
sleep 0.5

info "Pausing + snapshotting"
CODE=$(api PATCH /vm '{"state":"Paused"}')
expect_status 204 "${CODE}" "/vm Paused"
CODE=$(api PUT /snapshot/create "$(cat <<JSON
{"snapshot_path":"${SNAPFILE}","mem_file_path":"${MEMFILE}","snapshot_type":"Full"}
JSON
)")
expect_status 204 "${CODE}" /snapshot/create
pass "snapshot created ($(du -h "${MEMFILE}" | cut -f1) memfile, $(du -h "${SNAPFILE}" | cut -f1) snapshot)"

kill_firecracker

# ── Restore loop ────────────────────────────────────────────────────
info "Running ${ITERATIONS} restore iterations"
printf '' > "${MEASUREMENTS}"
FAILED=0

for i in $(seq 1 "${ITERATIONS}"); do
  spawn_firecracker
  CODE=$(api PUT /snapshot/load "$(cat <<JSON
{"snapshot_path":"${SNAPFILE}","mem_backend":{"backend_type":"File","backend_path":"${MEMFILE}"},"enable_diff_snapshots":false,"resume_vm":false}
JSON
)")
  if [ "${CODE}" != "204" ]; then
    echo "  iter ${i}: /snapshot/load returned ${CODE}: $(cat ${FC_RESP} 2>/dev/null || echo '(empty)')"
    FAILED=$((FAILED+1))
    kill_firecracker
    continue
  fi

  # Resume the VM, then immediately kick the probe.
  CODE=$(api PATCH /vm '{"state":"Resumed"}')
  if [ "${CODE}" != "204" ]; then
    echo "  iter ${i}: /vm Resumed returned ${CODE}: $(cat ${FC_RESP} 2>/dev/null || echo '(empty)')"
    FAILED=$((FAILED+1))
    kill_firecracker
    continue
  fi

  if MS=$(SPIKE_TIMEOUT_MS=5000 python3 "${PROBE_SCRIPT}" "${VSOCK_UDS}" "${VSOCK_PORT}" 2>/dev/null); then
    echo "${MS}" >> "${MEASUREMENTS}"
    # Brief progress indicator every 10 runs.
    if [ $((i % 10)) -eq 0 ]; then
      printf '  %3d / %3d — last %s ms\n' "${i}" "${ITERATIONS}" "${MS}"
    fi
  else
    echo "  iter ${i}: probe timed out"
    FAILED=$((FAILED+1))
  fi

  kill_firecracker
done

# ── Report ──────────────────────────────────────────────────────────
info "Results"
SUCCESS=$(wc -l < "${MEASUREMENTS}" | tr -d ' ')
echo "  success:  ${SUCCESS} / ${ITERATIONS}"
echo "  failures: ${FAILED}"

if [ "${SUCCESS}" -eq 0 ]; then
  fail "no successful iterations — snapshot/restore path not viable as-is"
fi

# Sort + pick percentiles. Keep it stdlib — no external stats tooling.
SORTED="${WORKDIR}/sorted.txt"
sort -n "${MEASUREMENTS}" > "${SORTED}"

percentile() {
  local pct="$1"
  local line=$(awk -v n="${SUCCESS}" -v p="${pct}" 'BEGIN { printf "%d", (n*p/100.0 + 0.5) }')
  [ "${line}" -lt 1 ] && line=1
  [ "${line}" -gt "${SUCCESS}" ] && line="${SUCCESS}"
  sed -n "${line}p" "${SORTED}"
}

MIN=$(head -n1 "${SORTED}")
MAX=$(tail -n1 "${SORTED}")
P50=$(percentile 50)
P95=$(percentile 95)
P99=$(percentile 99)
MEAN=$(awk '{s+=$1} END { printf "%.3f", s/NR }' "${SORTED}")

echo ""
echo "  resume-to-handshake-OK latency (ms):"
printf '    min   = %s\n' "${MIN}"
printf '    p50   = %s\n' "${P50}"
printf '    p95   = %s\n' "${P95}"
printf '    p99   = %s\n' "${P99}"
printf '    max   = %s\n' "${MAX}"
printf '    mean  = %s\n' "${MEAN}"
echo ""

# Interpretation gate: RED-256 targets <50 ms p95 for warm-restore +
# round-trip. The handshake-only latency measured here should be
# WELL under that since it's only the resume → first-accept-wake
# slice. A p95 > 20 ms here is a yellow flag (would eat most of
# the budget); > 50 ms is a red flag (scope changes for RED-256).
P95_WHOLE=$(printf '%.0f' "${P95}")
if [ "${P95_WHOLE}" -lt 20 ]; then
  pass "p95 ${P95} ms — green. Direct-dial after resume is viable; no retry needed in RED-256."
elif [ "${P95_WHOLE}" -lt 50 ]; then
  printf '  \033[33mWARN\033[0m  p95 %s ms — yellow. Leaves little room for the rest of the RED-256 budget.\n' "${P95}"
else
  printf '  \033[31mRED\033[0m   p95 %s ms — RED-256 target of <50 ms p95 requires retry or a different approach.\n' "${P95}"
fi

echo ""
echo "Raw measurements: ${MEASUREMENTS}"
echo "(script cleans up workdir on exit; copy out first if you want to keep them)"
