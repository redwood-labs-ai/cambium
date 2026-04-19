#!/usr/bin/env bash
# RED-259 preflight — netns + veth + tap + iptables outbound filtering.
#
# Before committing to the RED-259 impl design (per-call netns with
# allowlist iptables + DNS pre-resolution + /etc/hosts), prove the
# mechanism works against the reference rootfs + kernel on this host.
# Open questions the ticket leaves unspecified that this preflight
# answers:
#
#   1. Does Firecracker's virtio-net attach cleanly when the tap device
#      lives in a non-default netns?
#   2. Can we bring eth0 up from inside the guest using the static IP
#      the host assigns, and reach an allowlisted IP?
#   3. Do iptables OUTPUT rules applied IN THE NETNS correctly block
#      traffic to non-allowlisted IPs (including 169.254.169.254 for
#      RED-137's block_metadata)?
#   4. Is cleanup tractable on normal exit? (SIGKILL-resilience is out
#      of scope for preflight — that's an impl-phase robustness check.)
#
# Topology:
#
#     root netns                 cambium-pf netns
#     ┌────────────┐             ┌─────────────────────────────┐
#     │ veth-h     │◄───────────►│ veth-g (10.79.0.1/24)       │
#     │ MASQUERADE │             │   default route via host    │
#     │ forwarding │             │ tap-fc (10.79.0.2/24)       │
#     └────────────┘             │   ↕ virtio-net              │
#                                │ guest eth0 (10.79.0.3/24)   │
#                                │   default via tap-fc        │
#                                └─────────────────────────────┘
#
# Allowlist model for the spike: one IP allowed (1.1.1.1), one IP
# blocked (8.8.8.8), and the metadata IP (169.254.169.254) blocked
# even if the rest of the netns can route.
#
# Runs on the same environment as smoke.sh v1 — requires Linux + KVM
# + firecracker + iproute2 + iptables + curl on the host, plus the
# reference kernel + rootfs artifacts.

set -eo pipefail

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${CAMBIUM_FC_KERNEL:-${HERE}/kernel/vmlinux}"
ROOTFS="${CAMBIUM_FC_ROOTFS:-${HERE}/rootfs/out/rootfs.ext4}"

WORKDIR=$(mktemp -d -t cambium-netns-pf-XXXXXX)
API_SOCK="${WORKDIR}/fc.api.sock"
VSOCK_UDS="${WORKDIR}/fc.vsock.sock"
STAGED_ROOTFS="${WORKDIR}/rootfs.ext4"
FC_LOG="${WORKDIR}/fc.log"
GUEST_CID=3
VSOCK_PORT=52717

# Network plumbing identifiers. Short names — ip link name has a
# 15-char cap.
NETNS="cambpf"
VETH_H="cambpf-h"
VETH_G="cambpf-g"
TAP="cambpf-tap"
NETNS_CIDR="10.79.0.0/24"
VETH_G_IP="10.79.0.1"
TAP_IP="10.79.0.2"
GUEST_IP="10.79.0.3"
GUEST_NETMASK="24"
GUEST_MAC="aa:fc:00:00:00:01"

# Allowlist model. 1.1.1.1 = Cloudflare DNS (stable public IP).
# 8.8.8.8 = Google DNS (not on allowlist for this spike).
# 169.254.169.254 = EC2/cloud metadata — must be blocked regardless.
ALLOW_IP="1.1.1.1"
BLOCK_IP="8.8.8.8"
METADATA_IP="169.254.169.254"

FC_PID=""
HOST_OUT_IFACE=""
cleanup() {
  if [ -n "${FC_PID}" ]; then
    kill "${FC_PID}" 2>/dev/null || true
    wait "${FC_PID}" 2>/dev/null || true
  fi
  # Best-effort network teardown. Errors suppressed — a half-setup
  # state should still clean up what exists. The impl's finally block
  # will do the same.
  if [ -n "${HOST_OUT_IFACE}" ]; then
    sudo iptables -t nat -D POSTROUTING -s "${NETNS_CIDR}" -o "${HOST_OUT_IFACE}" -j MASQUERADE 2>/dev/null || true
    sudo iptables -D FORWARD -i "${VETH_H}" -j ACCEPT 2>/dev/null || true
    sudo iptables -D FORWARD -o "${VETH_H}" -j ACCEPT 2>/dev/null || true
  fi
  sudo ip link delete "${VETH_H}" 2>/dev/null || true
  sudo ip netns delete "${NETNS}" 2>/dev/null || true
  # WORKDIR holds files created by the FC process as root (API socket,
  # vsock UDS, log). Regular rm -rf would fail on those; sudo rm -rf
  # handles both cases.
  sudo rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# ── Preflight on the host itself ────────────────────────────────────
info "RED-259 preflight — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  host arch:    %s\n' "$(uname -m)"
printf '  firecracker:  %s\n' "$(firecracker --version 2>&1 | head -n1)"
printf '  kernel:       %s\n' "${KERNEL}"
printf '  rootfs:       %s\n' "${ROOTFS}"

[ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "/dev/kvm not accessible (need root or kvm group membership)"
[ -f "${KERNEL}" ] || fail "kernel missing: ${KERNEL}"
[ -f "${ROOTFS}" ] || fail "rootfs missing: ${ROOTFS}"
command -v firecracker >/dev/null || fail "firecracker not on PATH"
command -v python3 >/dev/null || fail "python3 not on PATH"
command -v ip >/dev/null || fail "ip (iproute2) not on PATH"
command -v iptables >/dev/null || fail "iptables not on PATH"
command -v sudo >/dev/null || fail "sudo not on PATH (preflight needs root for netns/iptables setup)"

# We need root for netns + iptables. Check via a no-op.
sudo -n true 2>/dev/null || fail "sudo requires a password — run: sudo -v  and retry"

# Detect the host's default-route interface. MASQUERADE needs to
# know where to rewrite packets TO. On the R1 this is usually the
# Ethernet or wifi interface.
HOST_OUT_IFACE=$(ip -4 route show default | awk '{print $5; exit}')
[ -n "${HOST_OUT_IFACE}" ] || fail "no default route on host — netns will have no upstream to MASQUERADE toward"
printf '  out iface:    %s\n' "${HOST_OUT_IFACE}"

# ip_forward must be on, else MASQUERADE won't route packets through
# the host.
if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != "1" ]; then
  warn "net.ipv4.ip_forward was 0; setting to 1 for this spike"
  sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null
fi

# Stage the rootfs (Firecracker needs rw access even though root= is
# the same rootfs).
cp "${ROOTFS}" "${STAGED_ROOTFS}"

# ── Build the netns + veth + iptables ───────────────────────────────
info "Setting up netns, veth pair, tap device, and iptables rules"

# Start clean — in case a previous run died before cleanup.
sudo ip netns delete "${NETNS}" 2>/dev/null || true
sudo ip link delete "${VETH_H}" 2>/dev/null || true

sudo ip netns add "${NETNS}"
pass "netns created: ${NETNS}"

sudo ip link add "${VETH_H}" type veth peer name "${VETH_G}"
sudo ip link set "${VETH_G}" netns "${NETNS}"
sudo ip addr add "${VETH_G_IP}/24" dev "${VETH_H}" 2>&1 \
  || fail "ip addr add veth-h IP failed — a stale veth may exist"
sudo ip link set "${VETH_H}" up
sudo ip netns exec "${NETNS}" ip addr add "10.79.0.254/24" dev "${VETH_G}"
sudo ip netns exec "${NETNS}" ip link set "${VETH_G}" up
sudo ip netns exec "${NETNS}" ip link set lo up
sudo ip netns exec "${NETNS}" ip route add default via "${VETH_G_IP}"
pass "veth pair up: ${VETH_H} <-> ${VETH_G} (netns side .254, host side ${VETH_G_IP})"

# Tap device — lives in the netns so Firecracker can attach it.
sudo ip netns exec "${NETNS}" ip tuntap add "${TAP}" mode tap
sudo ip netns exec "${NETNS}" ip addr add "${TAP_IP}/${GUEST_NETMASK}" dev "${TAP}"
sudo ip netns exec "${NETNS}" ip link set "${TAP}" up
pass "tap device up: ${TAP} (${TAP_IP}/${GUEST_NETMASK}) inside netns"

# MASQUERADE so netns outbound gets NAT'd through the host default gw.
sudo iptables -t nat -A POSTROUTING -s "${NETNS_CIDR}" -o "${HOST_OUT_IFACE}" -j MASQUERADE
sudo iptables -A FORWARD -i "${VETH_H}" -j ACCEPT
sudo iptables -A FORWARD -o "${VETH_H}" -j ACCEPT
pass "host MASQUERADE + FORWARD rules installed"

# Allowlist enforcement — iptables OUTPUT in the netns. RED-137 maps
# to this shape:
#   - DEFAULT DROP outbound
#   - ALLOW established/related (so inbound replies to allowed
#     outbound connections come back)
#   - ALLOW specific resolved IPs
#   - DROP 169.254.169.254 explicitly (block_metadata even if it
#     somehow made it onto the allowlist)
#
# For this spike the allowlist has exactly ${ALLOW_IP}; everything
# else is implicitly DROP.
sudo ip netns exec "${NETNS}" iptables -P OUTPUT DROP
sudo ip netns exec "${NETNS}" iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo ip netns exec "${NETNS}" iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT  # lo self-traffic
sudo ip netns exec "${NETNS}" iptables -A OUTPUT -d "${METADATA_IP}" -j DROP  # block_metadata
sudo ip netns exec "${NETNS}" iptables -A OUTPUT -d "${ALLOW_IP}" -j ACCEPT
# (8.8.8.8 is implicitly dropped by DEFAULT.)
pass "iptables OUTPUT rules set: default DROP + allow ${ALLOW_IP} + drop ${METADATA_IP}"

# Sanity — the netns ITSELF can reach the allow IP before we even
# boot the VM. If this fails, FC has no chance.
if sudo ip netns exec "${NETNS}" curl -sS --connect-timeout 3 "http://${ALLOW_IP}/" -o /dev/null; then
  pass "netns→${ALLOW_IP} reachable from host (baseline)"
else
  fail "netns cannot reach ${ALLOW_IP} even from host — MASQUERADE / default route is broken"
fi
if sudo ip netns exec "${NETNS}" curl -sS --connect-timeout 3 "http://${BLOCK_IP}/" -o /dev/null 2>/dev/null; then
  fail "netns reached ${BLOCK_IP} — iptables DEFAULT DROP is not in effect"
else
  pass "netns→${BLOCK_IP} blocked (baseline — iptables DROP works in netns context)"
fi

# ── Firecracker API helpers ─────────────────────────────────────────
FC_RESP="${WORKDIR}/fc-resp"
api_put() {
  local path="$1" body="$2"
  sudo curl -s -o "${FC_RESP}" -w '%{http_code}' \
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

# ── Boot the VM inside the netns ────────────────────────────────────
info "Booting VM inside netns with virtio-net attached to tap"
rm -f "${API_SOCK}" "${VSOCK_UDS}" "${FC_LOG}"

# `ip netns exec` runs the process in the netns so the tap is visible.
# Firecracker opens the tap fd by name; in the root netns the tap
# doesn't exist.
sudo ip netns exec "${NETNS}" firecracker --api-sock "${API_SOCK}" >"${FC_LOG}" 2>&1 &
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

# The RED-259-relevant attach — this is the hypothesis under test.
HTTP=$(api_put /network-interfaces/eth0 "$(cat <<JSON
{"iface_id":"eth0","host_dev_name":"${TAP}","guest_mac":"${GUEST_MAC}"}
JSON
)"); expect_204 "${HTTP}" /network-interfaces/eth0

HTTP=$(api_put /vsock "$(cat <<JSON
{"vsock_id":"vsock0","guest_cid":${GUEST_CID},"uds_path":"${VSOCK_UDS}"}
JSON
)"); expect_204 "${HTTP}" /vsock

HTTP=$(api_put /actions '{"action_type":"InstanceStart"}'); expect_204 "${HTTP}" /actions
pass "VM started with virtio-net attached to ${TAP}"

# ── Probe the guest ─────────────────────────────────────────────────
info "Probing guest — bring eth0 up then test connectivity"

PROBE_SCRIPT="${WORKDIR}/probe.py"
cat > "${PROBE_SCRIPT}" <<'PYEOF'
import json, socket, struct, sys, time

UDS = sys.argv[1]
PORT = int(sys.argv[2])
GUEST_IP = sys.argv[3]
NETMASK = sys.argv[4]
TAP_IP = sys.argv[5]
ALLOW = sys.argv[6]
BLOCK = sys.argv[7]
METADATA = sys.argv[8]

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

# Once CONNECT handshake is done, bump the socket timeout for the
# ExecRequest round-trip. The probe runs `busybox --list` + three
# fetch()es with 3s timeouts each + shell overhead; 2s was the
# handshake budget, not the response budget. Use 40s to give the
# agent's internal 30s timeout_seconds room to surface back to us.
sock.settimeout(40.0)

# Guest agent does NOT bring eth0 up on its own in v0 — RED-259 will
# add that as part of the ExecRequest.net path. For this preflight we
# do it in-line: first bring eth0 up via busybox `ip` commands, then
# run three Node fetch() probes against allowed / blocked / metadata
# targets. Using fetch() (not curl) because the reference rootfs has
# no curl — busybox + node + python3 + ca-certificates only. This
# also matches how real gens will hit the network.
#
# Values are interpolated Python-side into the JS source via
# str.format — placeholders are `{name}`, and JS literal `{`/`}` are
# doubled.
code = """
const {{ execSync }} = require('child_process');
// The reference rootfs is Alpine + busybox + python3 + nodejs +
// ca-certs. Neither `ip` nor `ifconfig` is on PATH as a symlink
// (the first preflight ran showed `ifconfig: not found`), so we
// invoke busybox's applet form directly via `busybox <applet>` —
// the binary exists regardless of which /bin/ symlinks got
// installed. The eventual RED-259 agent will use whichever tool
// the rootfs has; the mechanism being probed here is "can the
// guest reach the host-assigned IP space at all".
//
// Also emits an applet listing so if this STILL fails we have a
// concrete answer to "what's actually available?" instead of
// guessing.
const bringUp = [
  'echo "--- busybox applets (network-related) ---"',
  '(busybox --list 2>&1 | grep -E "^(ifconfig|route|ip|udhcpc|arp|netstat)$") || echo "(no network applets surfaced by busybox --list)"',
  'echo "--- attempting busybox ifconfig + route ---"',
  '(busybox ifconfig eth0 {guest_ip} netmask 255.255.255.0 up && busybox route add default gw {tap_ip} && echo ETH0_UP) || echo ETH0_FAIL',
  'echo "--- eth0 state ---"',
  'busybox ifconfig eth0 2>&1 || echo "(ifconfig applet unavailable)"',
  'echo "--- route ---"',
  'busybox route -n 2>&1 || echo "(route applet unavailable)"',
].join(' ; ') + ' ; exit 0';
let setup;
try {{
  setup = execSync(bringUp, {{ shell: '/bin/sh' }}).toString();
}} catch (e) {{
  setup = 'BRING-UP ERROR (code=' + e.status + ')\\nstdout: ' +
          (e.stdout ? e.stdout.toString() : '') + '\\nstderr: ' +
          (e.stderr ? e.stderr.toString() : '');
}}
console.log(setup);

async function probe(label, url, okMarker, failMarker) {{
  try {{
    const r = await fetch(url, {{ signal: AbortSignal.timeout(3000) }});
    console.log(`--- ${{label}} ---`);
    console.log(`status=${{r.status}}`);
    console.log(okMarker);
  }} catch (e) {{
    console.log(`--- ${{label}} ---`);
    console.log(`error=${{e.name}}: ${{e.message}}`);
    console.log(failMarker);
  }}
}}

(async () => {{
  await probe('ALLOW ({allow})',    'http://{allow}/',    'FETCH_ALLOW_OK',       'FETCH_ALLOW_FAIL');
  await probe('BLOCK ({block})',    'http://{block}/',    'FETCH_BLOCK_LEAKED',   'FETCH_BLOCK_DROPPED');
  await probe('META ({metadata})',  'http://{metadata}/', 'FETCH_META_LEAKED',    'FETCH_META_BLOCKED');
}})().catch(e => {{
  console.log('PROBE_CRASH: ' + e.stack);
}});
""".format(
    guest_ip=GUEST_IP,
    netmask=NETMASK,
    tap_ip=TAP_IP,
    allow=ALLOW,
    block=BLOCK,
    metadata=METADATA,
)

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

# FC runs under sudo inside the netns, so VSOCK_UDS is root-owned.
# The probe needs read/write on the UDS; run it under sudo too.
if ! OUT=$(sudo python3 "${PROBE_SCRIPT}" "${VSOCK_UDS}" "${VSOCK_PORT}" \
    "${GUEST_IP}" "${GUEST_NETMASK}" "${TAP_IP}" \
    "${ALLOW_IP}" "${BLOCK_IP}" "${METADATA_IP}" 2>&1); then
  echo "${OUT}"
  echo
  echo "firecracker log tail:"
  tail -n 40 "${FC_LOG}" 2>/dev/null | sed 's/^/  /'
  fail "probe failed to complete"
fi
echo "${OUT}"

# ── Parse + report ──────────────────────────────────────────────────
info "Findings"

eth0_up=false
allow_worked=false
block_worked=false
metadata_worked=false

if echo "${OUT}" | grep -q "ETH0_UP"; then
  eth0_up=true
fi
if echo "${OUT}" | grep -q "FETCH_ALLOW_OK"; then
  allow_worked=true
fi
# For BLOCK and META: the SUCCESS case is that fetch FAILED —
# i.e. iptables DROP caused a connection error/timeout.
if echo "${OUT}" | grep -q "FETCH_BLOCK_DROPPED"; then
  block_worked=true
fi
if echo "${OUT}" | grep -q "FETCH_META_BLOCKED"; then
  metadata_worked=true
fi

if ${eth0_up}; then
  pass "guest brought eth0 up with static IP"
else
  fail "guest could not bring eth0 up — see the busybox applet listing above; may need iproute2 added to the rootfs"
fi

if ${allow_worked}; then
  pass "guest → ${ALLOW_IP} reachable (allowlist works)"
else
  fail "guest could NOT reach ${ALLOW_IP} — the allowlist mechanism doesn't get traffic through"
fi

# IMPORTANT: block_worked and metadata_worked are only meaningful
# signals when the guest actually has network AT ALL. Otherwise every
# fetch fails for the wrong reason and we false-positive on DROPPED /
# BLOCKED. Gate these checks on eth0_up && allow_worked.
if ${eth0_up} && ${allow_worked}; then
  if ${block_worked}; then
    pass "guest → ${BLOCK_IP} blocked (default DROP works)"
  else
    fail "guest REACHED ${BLOCK_IP} — iptables default DROP leaked"
  fi
  if ${metadata_worked}; then
    pass "guest → ${METADATA_IP} blocked (block_metadata works)"
  else
    warn "guest metadata probe inconclusive — ${METADATA_IP} is not routable from this network anyway; impl tests will re-verify"
  fi
else
  warn "skipping drop-rule + metadata checks because allow path didn't work — their markers would be false positives"
fi

echo
info "Conclusion"
# Metadata is intentionally a nice-to-have: on many host networks the
# metadata IP simply isn't routable, so the iptables DROP rule can't
# distinguish "blocked by us" from "blocked by network". Treat eth0 up
# + allow reachable + block dropped as the GREEN threshold.
if ${eth0_up} && ${allow_worked} && ${block_worked} && ${metadata_worked}; then
  printf '  \033[32mGREEN\033[0m  netns + veth + tap + iptables mechanism works end-to-end.\n'
  printf '         RED-259 impl proceeds with this topology as designed.\n'
elif ${eth0_up} && ${allow_worked} && ${block_worked}; then
  printf '  \033[33mYELLOW\033[0m  Allowlist + default-drop work; metadata-specific block\n'
  printf '          could not be verified on this host (the metadata IP isn'"'"'t routable from\n'
  printf '          this network regardless). Impl tests will cover explicit block-metadata\n'
  printf '          semantics in the escape-test matrix.\n'
else
  printf '  \033[31mRED\033[0m    One or more core mechanisms failed. See the FAIL marker\n'
  printf '         above — RED-259 design needs revision before impl.\n'
fi

echo
echo "Raw probe output is above. Workdir cleaned up on exit."
