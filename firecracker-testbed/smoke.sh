#!/usr/bin/env bash
# Firecracker v0 smoke test (RED-251).
#
# Runs inside the testbed container. Verifies the three v0 floor
# properties: KVM accessible, Firecracker installed, API socket
# responding. Prints a clear PASS / FAIL per check so Komodo logs
# read as a status dashboard.
#
# Exits non-zero on any failure so Komodo / CI notices.

set -eo pipefail

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

info "Firecracker testbed v0 smoke — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
trap 'kill ${FC_PID} 2>/dev/null || true; rm -f "${API_SOCK}"' EXIT

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

info "All checks passed — testbed floor is solid."
echo
echo "Next steps (as impl tickets land):"
echo "  - pull/build an aarch64 minimal kernel (vmlinux)"
echo "  - pull/build a minimal rootfs image (ext4)"
echo "  - extend smoke.sh to boot a VM + exchange a vsock round-trip"
echo "  - wire the Rust cambium-agent for the real control plane"
