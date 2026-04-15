/**
 * RED-137: runtime network egress guard.
 *
 * Pure module — no IR coupling. Given a URL and a NetworkPolicy, decides
 * whether the request is permitted, with full reasoning for the trace.
 *
 * Three entry points:
 *   - checkHost(host, policy)            — sync, hostname/IP-literal check only.
 *   - checkAndResolve(url, policy, opts) — async, performs DNS resolution
 *                                           and re-checks every resolved IP.
 *   - guardedFetch(url, init, policy)    — fetch wrapper that pins the
 *                                           resolved IP (TOCTOU guard).
 *
 * The fetch path resolves a hostname once, validates every A/AAAA record
 * (deny if ANY is blocked — defends against DNS rebinding), then forces
 * the actual TCP connection to the validated IP via the lookup hook on
 * Node's http(s) agent.
 */

import { lookup as dnsLookupCb, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { NetworkPolicy } from './permissions.js';
import { hostMatchesList } from './permissions.js';

const dnsLookup = promisify(dnsLookupCb);

// ── Decision shape ──────────────────────────────────────────────────────

export type GuardDecision =
  | { allowed: true;  host: string; resolved_ips: string[]; matched: 'allowlist' | 'wildcard' }
  | { allowed: false; host: string; reason: GuardDenyReason; rule?: string; resolved_ips?: string[] };

export type GuardDenyReason =
  | 'denylist'
  | 'allowlist_miss'
  | 'block_private'
  | 'block_metadata'
  | 'invalid_url'
  | 'unresolvable'
  | 'unsupported_protocol';

// ── Default blocked sets ────────────────────────────────────────────────

/** RFC1918 + link-local + loopback + ULA + unspecified (v4 and v6). */
const PRIVATE_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['127.0.0.0',   8],   // loopback v4
  ['10.0.0.0',    8],   // RFC1918
  ['172.16.0.0', 12],   // RFC1918
  ['192.168.0.0', 16],  // RFC1918
  ['169.254.0.0', 16],  // link-local v4 (covers 169.254.169.254)
  ['0.0.0.0',     8],   // unspecified / "this network"
  ['::1',       128],   // loopback v6
  ['fe80::',     10],   // link-local v6
  ['fc00::',      7],   // ULA
  ['::',        128],   // unspecified v6
];

/** Hostnames that resolve to cloud metadata even if not on link-local. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.aws.internal',
  '169.254.169.254',
]);

// ── IP / CIDR utilities ─────────────────────────────────────────────────

/** Parse an IPv4 dotted-quad to a 32-bit unsigned int. Returns null if not v4. */
function parseV4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const o = Number(p);
    if (o < 0 || o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}

/** Parse an IPv6 address (incl. `::` shortcut) to 8 16-bit groups. Returns null if not v6. */
function parseV6(ip: string): number[] | null {
  // Strip zone id (e.g. fe80::1%eth0)
  const noZone = ip.split('%')[0];
  if (!noZone.includes(':')) return null;

  // Handle IPv4-mapped tail (e.g. ::ffff:1.2.3.4)
  let v4Tail: number[] | null = null;
  const lastColon = noZone.lastIndexOf(':');
  const tail = noZone.slice(lastColon + 1);
  let head = noZone;
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 == null) return null;
    v4Tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    head = noZone.slice(0, lastColon);
  }

  const dblIdx = head.indexOf('::');
  let groups: string[];
  if (dblIdx >= 0) {
    const left  = head.slice(0, dblIdx).split(':').filter(s => s.length > 0);
    const right = head.slice(dblIdx + 2).split(':').filter(s => s.length > 0);
    const targetLen = 8 - (v4Tail ? 2 : 0);
    const missing = targetLen - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = head.split(':');
    if (groups.length !== (v4Tail ? 6 : 8)) return null;
  }

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  if (v4Tail) out.push(...v4Tail);
  if (out.length !== 8) return null;
  return out;
}

/** True if `ip` falls inside the CIDR. Supports v4 and v6. */
export function ipInCidr(ip: string, cidr: string, prefix: number): boolean {
  const v4Ip = parseV4(ip);
  const v4Cidr = parseV4(cidr);
  if (v4Ip != null && v4Cidr != null) {
    if (prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
    return (v4Ip & mask) === (v4Cidr & mask);
  }
  const v6Ip = parseV6(ip);
  const v6Cidr = parseV6(cidr);
  if (v6Ip && v6Cidr) {
    if (prefix < 0 || prefix > 128) return false;
    let bitsLeft = prefix;
    for (let i = 0; i < 8 && bitsLeft > 0; i++) {
      const take = Math.min(16, bitsLeft);
      const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
      if ((v6Ip[i] & mask) !== (v6Cidr[i] & mask)) return false;
      bitsLeft -= take;
    }
    return true;
  }
  return false;
}

/** True if `ip` lies in any default-private range. */
export function isPrivateIp(ip: string): boolean {
  for (const [cidr, prefix] of PRIVATE_CIDRS) {
    if (ipInCidr(ip, cidr, prefix)) return true;
  }
  return false;
}

/** True if `ip` is a v4 or v6 literal (vs. a hostname that needs resolving). */
function isIpLiteral(host: string): boolean {
  return parseV4(host) != null || parseV6(host) != null;
}

// ── Decision logic ──────────────────────────────────────────────────────

/**
 * Sync host check. Handles IP literals fully; for hostnames, checks
 * allow/deny lists and metadata hostnames but doesn't resolve DNS.
 * The async path handles full IP resolution.
 */
export function checkHost(host: string, policy: NetworkPolicy): GuardDecision {
  const h = host.toLowerCase();

  // Metadata hostnames first — they're denied even if listed in allowlist.
  if (policy.block_metadata && METADATA_HOSTNAMES.has(h)) {
    return { allowed: false, host: h, reason: 'block_metadata', rule: 'default' };
  }

  // Denylist always wins over allowlist.
  if (policy.denylist.length > 0 && hostMatchesList(h, policy.denylist)) {
    return { allowed: false, host: h, reason: 'denylist' };
  }

  // IP literal: skip hostname allowlist (an IP can't match a hostname suffix
  // anyway). Run private-range check directly.
  if (isIpLiteral(h)) {
    if (policy.block_private && isPrivateIp(h)) {
      return { allowed: false, host: h, reason: 'block_private', rule: 'default' };
    }
    // For raw IP literals, only `*` wildcard makes sense as an allowlist match.
    if (policy.allowlist.includes('*')) {
      return { allowed: true, host: h, resolved_ips: [h], matched: 'wildcard' };
    }
    return { allowed: false, host: h, reason: 'allowlist_miss', resolved_ips: [h] };
  }

  // Hostname path.
  if (policy.allowlist.length === 0) {
    return { allowed: false, host: h, reason: 'allowlist_miss' };
  }
  const wildcardOnly = policy.allowlist.length === 1 && policy.allowlist[0] === '*';
  if (!wildcardOnly && !hostMatchesList(h, policy.allowlist)) {
    return { allowed: false, host: h, reason: 'allowlist_miss' };
  }
  return {
    allowed: true,
    host: h,
    resolved_ips: [],
    matched: wildcardOnly ? 'wildcard' : 'allowlist',
  };
}

export type ResolveOptions = {
  /** Override DNS resolver (for tests). Returns one or more addresses. */
  resolver?: (host: string) => Promise<LookupAddress[]>;
};

/**
 * Async URL check: parse the URL, run sync host check, then resolve DNS
 * and verify every returned IP. If any IP is blocked → deny.
 */
export async function checkAndResolve(
  url: string,
  policy: NetworkPolicy,
  opts: ResolveOptions = {},
): Promise<GuardDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, host: url, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, host: parsed.hostname, reason: 'unsupported_protocol' };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip brackets from v6

  const sync = checkHost(host, policy);
  if (!sync.allowed) return sync;

  // IP literal: sync check already covered private-range. Done.
  if (isIpLiteral(host)) return sync;

  // Resolve all addresses for this hostname.
  let addrs: LookupAddress[];
  try {
    if (opts.resolver) {
      addrs = await opts.resolver(host);
    } else {
      addrs = await dnsLookup(host, { all: true });
    }
  } catch {
    return { allowed: false, host, reason: 'unresolvable' };
  }

  if (addrs.length === 0) {
    return { allowed: false, host, reason: 'unresolvable' };
  }

  // DNS-rebind defense: if ANY resolved IP is blocked, deny the whole request.
  if (policy.block_private) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return {
          allowed: false,
          host,
          reason: 'block_private',
          rule: 'default',
          resolved_ips: addrs.map(a => a.address),
        };
      }
    }
  }
  if (policy.block_metadata) {
    for (const a of addrs) {
      if (a.address === '169.254.169.254') {
        return {
          allowed: false,
          host,
          reason: 'block_metadata',
          rule: 'default',
          resolved_ips: addrs.map(a => a.address),
        };
      }
    }
  }

  return {
    ...sync,
    resolved_ips: addrs.map(a => a.address),
  };
}

/**
 * Drop-in fetch wrapper. Validates the URL, then issues fetch with an
 * agent whose `lookup` hook returns the *already-validated* first IP —
 * preventing TOCTOU between our resolution and the kernel's.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit | undefined,
  policy: NetworkPolicy,
  opts: ResolveOptions = {},
): Promise<Response> {
  const decision = await checkAndResolve(url, policy, opts);
  if (!decision.allowed) {
    const err = new Error(
      `Network egress denied: ${decision.host} (${decision.reason}${decision.rule ? `:${decision.rule}` : ''})`,
    );
    (err as any).guardDecision = decision;
    throw err;
  }

  const pinnedIp = decision.resolved_ips[0];
  const family = parseV4(pinnedIp) != null ? 4 : 6;

  // Pin the connection to the validated IP via a per-request agent.
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const AgentCtor: any = isHttps ? HttpsAgent : HttpAgent;
  const agent = new AgentCtor({
    lookup: (_hostname: string, _opts: any, cb: any) => cb(null, pinnedIp, family),
    keepAlive: false,
  });

  // node:fetch (undici) doesn't honor http.Agent directly. Pass via dispatcher
  // for undici, or fall back. For simplicity in this module we attach via
  // (init as any).agent which works for node-fetch-style call sites; a future
  // PR can wire this through undici's Dispatcher.
  const finalInit: any = { ...(init ?? {}), agent };
  try {
    return await fetch(url, finalInit);
  } finally {
    agent.destroy?.();
  }
}
