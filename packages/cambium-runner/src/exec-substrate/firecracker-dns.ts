/**
 * Host-side DNS pre-resolution for the `:firecracker` network
 * allowlist (RED-259).
 *
 * The guest rootfs has no DNS resolver by design — adding one would
 * require a stub server inside the netns and a second allowlist for
 * which resolvers the guest may contact, which compounds rather than
 * simplifies the security story. Instead, the host resolves each
 * allowlisted hostname BEFORE dispatch and hands the guest a pre-
 * baked `/etc/hosts` + a set of iptables-allowed destination IPs.
 *
 * The tradeoff is that DNS round-robin / geo-DNS return one IP per
 * resolution — if the target's IP rotates between calls, different
 * dispatches may see different IPs. That's acceptable for Cambium's
 * use case (short-lived gens) and consistent with how most
 * container networking behaves.
 *
 * Policy interaction:
 *   - `block_metadata: true` → resolution rejects 169.254.169.254
 *     specifically (would only appear via adversarial allowlist).
 *   - `block_private: true` → resolution rejects RFC1918 + loopback
 *     + link-local at resolve time. Rejecting here + in the netns
 *     iptables is defense-in-depth.
 *
 * v1 scope:
 *   - IPv4 only. IPv6 results from `dns.resolve6` are ignored. The
 *     netns iptables rules are v4-only too, matching.
 *   - Wildcard `["*"]` allowlists are rejected — `:firecracker`'s
 *     netns model requires enumerable destinations. A gen that truly
 *     needs unrestricted network should use `runtime: :native` or
 *     declare specific hosts.
 *   - `denylist` is not yet applied at resolution time. Document
 *     this as a v1.5 gap: if the policy's allowlist is sane, the
 *     denylist is a safety net that should rarely fire, but not
 *     applying it here means the iptables-level block_private /
 *     block_metadata are the only enforced exclusions. Fix in
 *     v1.5 or when a gen tries to rely on it.
 */

import { isIP } from 'node:net';
import { resolve4 as _resolve4 } from 'node:dns/promises';
import type { NetworkPolicy } from '../tools/permissions.js';

/**
 * Result of resolving an allowlist. Carries both the host→IP
 * mapping (for /etc/hosts) and the de-duplicated set of destination
 * IPs (for iptables rules). The two aren't redundant: literal-IP
 * allowlist entries contribute to `allowedIps` but NOT to `hosts`
 * (nothing to resolve).
 */
export interface ResolvedAllowlist {
  /** (name, ip) pairs for `/etc/hosts`. One entry per hostname,
   *  always resolved to exactly one IP for determinism. */
  hosts: Array<{ name: string; ip: string }>;
  /** Union of all resolved IPs + literal-IP allowlist entries. No
   *  duplicates. Sorted for deterministic iptables rule ordering. */
  allowedIps: string[];
}

/** Cloud metadata IP. Matches firecracker-netns's constant; kept
 *  separate here to avoid a module cycle (netns imports nothing
 *  from dns). */
const METADATA_IP = '169.254.169.254';

/**
 * Resolve every entry in `policy.allowlist` to IP(s) using the
 * host's DNS resolver (for hostnames) or as-is (for literal IPs).
 * Throws a descriptive error on:
 *   - wildcard allowlist (`"*"` anywhere in the list)
 *   - unresolvable hostname (NXDOMAIN, timeout, etc)
 *   - an entry that resolves to only blocked IPs under the policy
 *     (no usable IP means the rule can't fire)
 *
 * The injectable `resolver` parameter is for testing — in
 * production, always uses `node:dns/promises.resolve4`.
 */
export async function resolveAllowlist(
  policy: NetworkPolicy,
  options: { resolver?: (hostname: string) => Promise<string[]> } = {},
): Promise<ResolvedAllowlist> {
  if (policy.allowlist.includes('*')) {
    throw new Error(
      'NetworkPolicy.allowlist contains "*" (any host) — :firecracker requires ' +
        'an enumerable allowlist. Declare the specific hosts your gen needs, or ' +
        "switch to runtime: :native if truly unrestricted network access is required.",
    );
  }

  const resolver = options.resolver ?? defaultResolver;
  const hosts: Array<{ name: string; ip: string }> = [];
  const allowed = new Set<string>();

  for (const entry of policy.allowlist) {
    const kind = isIP(entry);
    if (kind === 4) {
      // Literal IPv4 — no hostname mapping, just a direct IP rule.
      if (isBlocked(entry, policy)) {
        throw new Error(
          `allowlist entry ${JSON.stringify(entry)} is a literal IP that the ` +
            `policy blocks (block_private=${policy.block_private}, ` +
            `block_metadata=${policy.block_metadata}). Remove the entry or ` +
            `loosen the policy.`,
        );
      }
      allowed.add(entry);
      continue;
    }
    if (kind === 6) {
      // v1 is IPv4-only at the iptables layer. A v6 literal in the
      // allowlist is a shape we accept but don't enforce; log + skip.
      // Forward-compat: when iptables rules get a v6 path, this
      // branch becomes a real allow.
      continue;
    }
    // Hostname — resolve via DNS.
    const ips = await resolver(entry).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`DNS resolution failed for ${JSON.stringify(entry)}: ${msg}`);
    });
    const usable = ips.filter((ip) => !isBlocked(ip, policy));
    if (usable.length === 0) {
      throw new Error(
        `allowlist entry ${JSON.stringify(entry)} resolved to ${ips.length} ` +
          `IP(s) (${ips.join(', ')}), all blocked by policy ` +
          `(block_private=${policy.block_private}, block_metadata=${policy.block_metadata}). ` +
          `Either the hostname points at a private/metadata range, or the policy ` +
          `is too restrictive for this entry.`,
      );
    }
    // Pick exactly one IP per hostname for the /etc/hosts mapping.
    // Using the FIRST usable result keeps the mapping deterministic
    // within a single dispatch; the full set still participates in
    // iptables allows so the guest can reconnect to any of them if
    // it uses a different resolution path later.
    hosts.push({ name: entry, ip: usable[0]! });
    for (const ip of usable) allowed.add(ip);
  }

  return {
    hosts,
    allowedIps: Array.from(allowed).sort(),
  };
}

/** Is `ip` blocked by the policy's coarse filters? */
function isBlocked(ip: string, policy: NetworkPolicy): boolean {
  if (policy.block_metadata && ip === METADATA_IP) return true;
  if (policy.block_private && ipIsPrivateV4(ip)) return true;
  return false;
}

/**
 * IPv4-only classifier for RFC1918 + loopback + link-local. Returns
 * `false` for non-v4 inputs (including v6 and malformed strings) —
 * the `block_private` flag is IPv4-scoped in v1, matching the
 * iptables rules.
 */
export function ipIsPrivateV4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map((s) => Number.parseInt(s, 10));
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

async function defaultResolver(hostname: string): Promise<string[]> {
  return _resolve4(hostname);
}
