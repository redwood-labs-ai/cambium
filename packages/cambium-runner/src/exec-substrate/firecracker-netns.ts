/**
 * Per-call netns + veth + tap + iptables lifecycle for the
 * `:firecracker` substrate's network policy support (RED-259).
 *
 * Mirrors the topology the RED-259 preflight proved GREEN on the
 * MS-R1 (2026-04-19): disjoint subnets for host↔netns and netns↔guest,
 * return-path route in the root netns for reply packets, ip_forward
 * enabled inside the netns, `-I FORWARD 1` ACCEPTs at the head of
 * the root FORWARD chain (survives UFW / Docker / Tailscale chain
 * ordering), post-start tap re-up.
 *
 * ## Privilege model
 *
 * Netns / veth / tap / iptables manipulation requires `CAP_NET_ADMIN`.
 * Two paths are supported:
 *
 *   1. **Default**: Cambium dispatches commands via `sudo -n` (non-
 *      interactive). The developer is expected to have run `sudo -v`
 *      before invoking Cambium, or to have the relevant commands
 *      configured with NOPASSWD in sudoers. A missing / expired
 *      credential surfaces as a clean failure at setup time rather
 *      than a mid-run prompt.
 *
 *   2. **Pre-prepared netns** (`CAMBIUM_FC_PREPARED_NETNS=<name>`):
 *      the operator creates the netns + tap + iptables rules out of
 *      band (typically at boot, via a systemd unit), and Cambium
 *      treats it as read-only — it only runs Firecracker inside the
 *      netns via `ip netns exec`. This avoids the sudo requirement
 *      entirely at dispatch time. The pre-prepared netns MUST use
 *      the same names / subnets / IPs this module defines
 *      (`NETNS_NAME`, `TAP`, `GUEST_IP`, etc.) so the NetConfig
 *      Cambium sends the guest agent lines up.
 *
 * ## Concurrency
 *
 * v1 assumes sequential dispatch: one :firecracker-with-network run
 * at a time per host. The netns and veth device names are constants,
 * not per-call-unique — two concurrent runs would race on setup and
 * corrupt each other's state. Concurrent support is a v1.5 concern
 * (add a per-call prefix derived from PID or a counter); document
 * the limitation and defer.
 */

import { spawn } from 'node:child_process';
import type { NetworkPolicy } from '../tools/permissions.js';

// ── Topology identifiers — MUST match CAMBIUM_FC_PREPARED_NETNS ────
//
// When operators pre-create the netns out of band, they MUST mirror
// these exact names / subnets / IPs. Changing any of these constants
// is a breaking change for the pre-prepared-netns path.

export const NETNS_NAME = 'cambium-fc';
export const VETH_H = 'cam-fc-h';
export const VETH_G = 'cam-fc-g';
export const TAP = 'cam-fc-tap';

export const VETH_SUBNET = '10.100.0.0/24';
export const VETH_H_IP = '10.100.0.1';
export const VETH_G_IP = '10.100.0.2';
export const GUEST_SUBNET = '10.200.0.0/24';
export const TAP_IP = '10.200.0.1';
export const GUEST_IP = '10.200.0.2';
export const GUEST_IP_CIDR = '10.200.0.2/24';
export const GUEST_MAC = 'aa:fc:00:00:00:01';

/** RFC 1918 + loopback — what `block_private: true` rejects. The
 *  rules drop traffic DESTINED to these ranges regardless of allowlist
 *  (defense-in-depth: an allowlist entry that resolves to a private IP
 *  must not slip through). */
export const PRIVATE_CIDRS: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local — metadata is a subset but this covers the whole range
];

/** Cloud metadata IP — what `block_metadata: true` rejects explicitly.
 *  Applied BEFORE allowlist ACCEPTs so an attacker-influenced allowlist
 *  entry can't unblock it. */
export const METADATA_IP = '169.254.169.254';

/** Shared handle describing the current network state. Returned by
 *  `setupNetns`, consumed by `teardownNetns` and the dispatch path. */
export interface NetnsHandle {
  /** Netns name (always NETNS_NAME in v1; field exists for future
   *  concurrent support). */
  netns: string;
  /** Tap device the guest's virtio-net attaches to. */
  tap: string;
  /** Host-side veth pair member. */
  vethHost: string;
  /** Netns-side veth pair member. */
  vethNetns: string;
  /** Host's default-route egress interface (for MASQUERADE scoping).
   *  Detected at setup time; `teardownNetns` uses the same value to
   *  reverse the MASQUERADE rule. */
  hostOutIface: string;
  /** True when the netns was supplied by `CAMBIUM_FC_PREPARED_NETNS`.
   *  Setup is a no-op and teardown is a no-op in this mode; the
   *  operator owns the lifecycle. */
  operatorManaged: boolean;
}

export interface SetupOpts {
  policy: NetworkPolicy;
  /** IP addresses the host pre-resolved from the policy's allowlist.
   *  Deduplicated; one ACCEPT rule per unique IP. Must NOT include
   *  private / metadata IPs if the policy blocks them — caller's
   *  responsibility to filter (see `firecracker-dns.ts`). */
  allowedIps: readonly string[];
}

/**
 * Build the netns-side FORWARD chain rules for the policy. Pure
 * function — no spawn. Returns an array of argv slices; each slice
 * is the args after `iptables` (e.g., `['-A', 'FORWARD', '-d',
 * '1.1.1.1', '-j', 'ACCEPT']`). Rule ordering matters: metadata
 * DROP first, then private DROP if enabled, then ACCEPT per allowed
 * IP, with the chain defaulting to DROP.
 *
 * The split between "stateful ACCEPT for RELATED,ESTABLISHED"
 * (required for reply packets) and "per-destination ACCEPT" is
 * intentional: conntrack handles return paths without needing to
 * re-whitelist the remote's source. Without the conntrack rule,
 * the guest's SYN gets out but the SYN-ACK reply doesn't match any
 * ACCEPT and gets dropped — exactly the "outbound works, connection
 * times out" failure mode.
 */
export function buildNetnsForwardRules(
  allowedIps: readonly string[],
  policy: NetworkPolicy,
): string[][] {
  const rules: string[][] = [];

  // Stateful — replies to allowed outbound connections come back.
  rules.push(['-A', 'FORWARD', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);

  // Metadata block BEFORE any allow — RED-137's block_metadata
  // guarantee must hold even if the allowlist somehow named it.
  if (policy.block_metadata) {
    rules.push(['-A', 'FORWARD', '-d', METADATA_IP, '-j', 'DROP']);
  }

  // Private-range block — same rationale as metadata.
  if (policy.block_private) {
    for (const cidr of PRIVATE_CIDRS) {
      rules.push(['-A', 'FORWARD', '-d', cidr, '-j', 'DROP']);
    }
  }

  // Allowlist per unique IP. The caller has already resolved hostnames.
  const uniqueIps = Array.from(new Set(allowedIps)).sort();
  for (const ip of uniqueIps) {
    rules.push(['-A', 'FORWARD', '-d', ip, '-j', 'ACCEPT']);
  }

  return rules;
}

/**
 * Run a privileged command. In v1, dispatches to `sudo -n` unless the
 * process is already root. `sudo -n` fails fast (no password prompt)
 * if credentials aren't cached — surfaces as a clean setup error
 * rather than hanging on stdin.
 *
 * Escape hatch: `CAMBIUM_FC_NETNS_NOSUDO=1` skips the sudo prefix
 * even for non-root. For environments with filesystem-level capability
 * grants (`setcap cap_net_admin+ep /usr/bin/ip`) where sudo isn't
 * needed or wanted.
 */
async function runPrivileged(argv: readonly string[]): Promise<void> {
  if (argv.length === 0) throw new Error('runPrivileged: empty argv');
  const needsSudo = process.getuid?.() !== 0 && process.env.CAMBIUM_FC_NETNS_NOSUDO !== '1';
  const full = needsSudo ? ['sudo', '-n', ...argv] : [...argv];
  return runCommand(full[0]!, full.slice(1));
}

/** Run an arbitrary command, awaiting exit. Rejects on non-zero exit
 *  with a message including argv + stderr + exit code. */
function runCommand(cmd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      // Truncate — some commands emit large amounts of output on error
      // and unbounded buffering here would be a memory issue under load.
      if (stderr.length > 4096) stderr = stderr.slice(0, 4096) + '…(truncated)';
    });
    child.once('error', (err) => {
      reject(new Error(`spawn ${cmd}: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const status = code !== null ? `exit ${code}` : `signal ${signal}`;
        const argvStr = [cmd, ...args].join(' ');
        reject(new Error(`${argvStr}: ${status}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

/** Detect the host's default IPv4 route egress interface. Fails
 *  cleanly if there's no default route — a host with no upstream
 *  connectivity can't usefully MASQUERADE outbound guest traffic. */
export async function detectHostOutIface(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ip', ['-4', 'route', 'show', 'default'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.once('error', (err) => reject(new Error(`ip route: ${err.message}`)));
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ip route show default: exit ${code}`));
        return;
      }
      // Output shape: `default via 192.168.1.1 dev eth0 proto dhcp ...`
      const match = stdout.match(/^default .* dev (\S+)/m);
      if (!match) {
        reject(
          new Error('no default IPv4 route on host — cannot MASQUERADE outbound traffic'),
        );
        return;
      }
      resolve(match[1]!);
    });
  });
}

/**
 * Create the netns + veth + tap + iptables state end-to-end. On
 * failure, leaves the host in the state it found: any partial setup
 * is torn down before the error propagates. The caller can treat
 * a rejected setupNetns as "nothing changed on the host".
 *
 * Fast-path: `CAMBIUM_FC_PREPARED_NETNS=<name>` skips all setup and
 * returns a handle flagged `operatorManaged: true`. The netns must
 * exist and be populated with the expected shape.
 */
export async function setupNetns(opts: SetupOpts): Promise<NetnsHandle> {
  const preparedNs = process.env.CAMBIUM_FC_PREPARED_NETNS;
  if (preparedNs) {
    // Sanity: confirm the netns actually exists. A typo in the env
    // var would otherwise surface much later as "firecracker: can't
    // find tap device".
    await assertNetnsExists(preparedNs);
    return {
      netns: preparedNs,
      tap: TAP,
      vethHost: VETH_H,
      vethNetns: VETH_G,
      // For operator-managed, use the host default iface; operator
      // installed MASQUERADE themselves but we still need the name for
      // potential diagnostics.
      hostOutIface: await detectHostOutIface(),
      operatorManaged: true,
    };
  }

  const hostOutIface = await detectHostOutIface();
  const handle: NetnsHandle = {
    netns: NETNS_NAME,
    tap: TAP,
    vethHost: VETH_H,
    vethNetns: VETH_G,
    hostOutIface,
    operatorManaged: false,
  };

  // Best-effort teardown of any stale state from a previous run that
  // died before its own cleanup. Idempotent and tolerant of "does not
  // exist" errors (the commands return non-zero but we swallow).
  await teardownBestEffort(handle);

  try {
    await runPrivileged(['ip', 'netns', 'add', NETNS_NAME]);

    // veth pair: peer in the netns.
    await runPrivileged(['ip', 'link', 'add', VETH_H, 'type', 'veth', 'peer', 'name', VETH_G]);
    await runPrivileged(['ip', 'link', 'set', VETH_G, 'netns', NETNS_NAME]);
    await runPrivileged(['ip', 'addr', 'add', `${VETH_H_IP}/24`, 'dev', VETH_H]);
    await runPrivileged(['ip', 'link', 'set', VETH_H, 'up']);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'addr', 'add', `${VETH_G_IP}/24`, 'dev', VETH_G]);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'link', 'set', VETH_G, 'up']);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'link', 'set', 'lo', 'up']);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'route', 'add', 'default', 'via', VETH_H_IP]);

    // ip_forward MUST be enabled inside the netns — the netns has its
    // own sysctl tree that defaults to 0. Preflight finding.
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'sysctl', '-w', 'net.ipv4.ip_forward=1']);

    // Return-path route in root: without this, reply packets un-NAT
    // back to 10.200.0.2 and loop out the default route. Preflight
    // finding.
    await runPrivileged(['ip', 'route', 'add', GUEST_SUBNET, 'via', VETH_G_IP, 'dev', VETH_H]);

    // Tap device in the netns.
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'tuntap', 'add', TAP, 'mode', 'tap']);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'addr', 'add', `${TAP_IP}/24`, 'dev', TAP]);
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'ip', 'link', 'set', TAP, 'up']);

    // Root MASQUERADE + FORWARD ACCEPTs. `-I FORWARD 1` inserts at
    // head so our ACCEPT fires before UFW / Tailscale / Docker chain
    // jumps that follow.
    await runPrivileged(['iptables', '-t', 'nat', '-A', 'POSTROUTING', '-s', GUEST_SUBNET, '-o', hostOutIface, '-j', 'MASQUERADE']);
    await runPrivileged(['iptables', '-I', 'FORWARD', '1', '-i', VETH_H, '-j', 'ACCEPT']);
    await runPrivileged(['iptables', '-I', 'FORWARD', '1', '-o', VETH_H, '-j', 'ACCEPT']);

    // Netns FORWARD policy + allowlist. Default DROP so non-allowed
    // destinations fall off the end. Order: stateful, metadata DROP,
    // private DROP, per-IP ACCEPT (see buildNetnsForwardRules).
    await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'iptables', '-P', 'FORWARD', 'DROP']);
    const forwardRules = buildNetnsForwardRules(opts.allowedIps, opts.policy);
    for (const ruleArgs of forwardRules) {
      await runPrivileged(['ip', 'netns', 'exec', NETNS_NAME, 'iptables', ...ruleArgs]);
    }

    return handle;
  } catch (err) {
    // Mid-setup failure: leave the host in its original state.
    await teardownBestEffort(handle);
    throw err;
  }
}

/**
 * Tear down everything `setupNetns` created. Safe to call multiple
 * times; each command is best-effort and "doesn't exist" errors are
 * swallowed. Operator-managed handles are a no-op — the operator
 * owns the lifecycle.
 */
export async function teardownNetns(handle: NetnsHandle): Promise<void> {
  if (handle.operatorManaged) return;
  await teardownBestEffort(handle);
}

async function teardownBestEffort(handle: NetnsHandle): Promise<void> {
  const cmds: string[][] = [
    // iptables (reverse order of insertion — the -D specifies rule
    // args and deletes a matching rule). Root side first, then netns.
    ['iptables', '-t', 'nat', '-D', 'POSTROUTING', '-s', GUEST_SUBNET, '-o', handle.hostOutIface, '-j', 'MASQUERADE'],
    ['iptables', '-D', 'FORWARD', '-i', handle.vethHost, '-j', 'ACCEPT'],
    ['iptables', '-D', 'FORWARD', '-o', handle.vethHost, '-j', 'ACCEPT'],
    // Return route on root.
    ['ip', 'route', 'del', GUEST_SUBNET, 'via', VETH_G_IP, 'dev', handle.vethHost],
    // Veth (cascade-deletes the tap + netns-side peer too, but we
    // also delete the netns explicitly for cleanliness).
    ['ip', 'link', 'delete', handle.vethHost],
    // Netns (implicitly destroys anything still inside — tap, peer
    // veth, lo).
    ['ip', 'netns', 'delete', handle.netns],
  ];
  for (const argv of cmds) {
    try {
      await runPrivileged(argv);
    } catch {
      // Best-effort — these fail when the entity doesn't exist and
      // that's fine; the goal is "host state clean" regardless of
      // what we started with.
    }
  }
}

async function assertNetnsExists(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ip', ['netns', 'list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.once('error', (err) => reject(new Error(`ip netns list: ${err.message}`)));
    child.once('exit', () => {
      // `ip netns list` prints one name per line (optionally with
      // `(id: N)` suffix). Check for exact match on the first whitespace
      // token of any line.
      const has = stdout.split('\n').some((line) => line.trim().split(/\s+/)[0] === name);
      if (has) resolve();
      else
        reject(
          new Error(
            `CAMBIUM_FC_PREPARED_NETNS=${JSON.stringify(name)} but that netns does not exist — ` +
              `run 'ip netns list' to confirm, or unset the env var to let Cambium create its own.`,
          ),
        );
    });
  });
}
