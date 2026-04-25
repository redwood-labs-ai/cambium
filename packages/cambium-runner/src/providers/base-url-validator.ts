// ── Provider base-URL validation (RED-322 / RED-325 Part 5) ───────────
//
// Each provider's base URL comes from an operator-controlled env var
// (CAMBIUM_OMLX_BASEURL, CAMBIUM_OLLAMA_BASEURL, CAMBIUM_ANTHROPIC_BASEURL)
// and is passed directly to fetch with bearer tokens attached. A
// poisoned-env CI job or a careless deploy manifest can ship API
// credentials to private-range / metadata endpoints by setting the
// var to e.g. `http://169.254.169.254`.
//
// The framework-internal provider fetches deliberately don't go through
// `guardedFetch` — they're framework-owned egress, not tool dispatch
// (RED-137's guard is scoped to tool egress). This module adds the
// missing layer: a lightweight scheme + CIDR check at the base-URL
// layer, validated once per provider on first dispatch.
//
// Operators can opt out via CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1
// for legitimate internal-VLAN proxy setups; the validator emits a
// one-time stderr warning in that case so the choice is auditable.

const _validatedUrls = new Set<string>();
const _warnedEscapeHatches = new Set<string>();

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// IPv4 CIDR ranges that should never carry provider credentials by
// default. CGNAT (100.64.0.0/10) is intentionally NOT here — that's
// where Tailscale and WireGuard tailnets live, and tailnet-fronted
// self-hosted models are a real deployment shape we don't want to
// reject by default.
type Cidr = { net: number; mask: number };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const oct = Number(p);
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null;
    n = (n * 256) + oct;
  }
  return n >>> 0;
}

function cidr(prefix: string, bits: number): Cidr {
  const net = ipv4ToInt(prefix);
  if (net === null) throw new Error(`invalid CIDR prefix: ${prefix}`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: net & mask, mask };
}

const PRIVATE_RANGES_V4: Cidr[] = [
  cidr('10.0.0.0', 8),       // RFC1918
  cidr('172.16.0.0', 12),    // RFC1918
  cidr('192.168.0.0', 16),   // RFC1918
  cidr('169.254.0.0', 16),   // link-local + AWS/GCP/Azure metadata
  cidr('127.0.0.0', 8),      // loopback (security review: 127.0.0.2+ wasn't covered;
                             //   the exact host `127.0.0.1` is exempted via LOCALHOST_HOSTS
                             //   for http+localhost convenience, but other 127/8 IPs
                             //   shouldn't carry credentials silently)
];

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const r of PRIVATE_RANGES_V4) {
    if ((n & r.mask) === r.net) return true;
  }
  return false;
}

// Conservative IPv6 private detection: ULA (fc00::/7), link-local
// (fe80::/10), loopback (::1), and IPv4-mapped IPv6 forms of any
// private IPv4 range. Doesn't cover everything but catches the
// realistic misconfigured-env cases.
function isPrivateIPv6(host: string): boolean {
  const trimmed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // ULA: first byte is 0xfc or 0xfd (fc00::/7)
  if (/^fc[0-9a-f]{2}:/i.test(trimmed)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(trimmed)) return true;
  // Link-local: fe80::/10 — second nibble of second byte must be 8-b
  // (security review fix: previous /^fe8[0-9a-f]:/i covered only /12,
  // missing fe90 through febf which are also link-local).
  if (/^fe[89ab][0-9a-f]:/i.test(trimmed)) return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:hexhi:hexlo. Node's URL
  // constructor normalizes the dotted form to the hex-pair form, so
  // we extract the embedded IPv4 from either form and run the IPv4
  // private check (security review fix: ::ffff:192.168.1.1 was a bypass).
  const v4Mapped = extractIPv4MappedV6(trimmed);
  if (v4Mapped !== null && isPrivateIPv4(v4Mapped)) return true;
  return false;
}

// Extract the embedded IPv4 from an IPv4-mapped IPv6 address. Accepts
// both the dotted form (::ffff:192.168.1.1) and the hex-pair form that
// Node's URL constructor produces (::ffff:c0a8:101). Returns null if
// the input isn't an IPv4-mapped form.
function extractIPv4MappedV6(s: string): string | null {
  const lower = s.toLowerCase();
  // Dotted form: ::ffff:a.b.c.d
  const dottedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) return dottedMatch[1];
  // Hex-pair form: ::ffff:HHHH:HHHH (the two 16-bit groups encode the four IPv4 octets)
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

function isLocalhostHost(host: string): boolean {
  return LOCALHOST_HOSTS.has(host.toLowerCase());
}

function escapeHatchEnabled(): boolean {
  return process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL === '1';
}

/**
 * Validate a provider base URL. Throws on rejected URLs unless the
 * escape hatch is engaged. Memoizes per (providerLabel, url) so the
 * second call for the same provider is a no-op.
 *
 * Behavior:
 * - Reject non-https UNLESS host is localhost / 127.0.0.1 / ::1
 * - Reject private-range IPs (10/8, 172.16/12, 192.168/16, 169.254/16,
 *   ULA fc00::/7, link-local fe80::/10) UNLESS
 *   CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1 is set
 * - CGNAT (100.64.0.0/10) is intentionally NOT rejected — Tailscale
 *   and WireGuard tailnets live in this range; tailnet-fronted
 *   self-hosted models are a real deployment shape
 * - Hostnames (non-IP) pass scheme check; we don't resolve DNS here
 *   (would add startup latency and TOCTOU concerns; the static URL
 *   string check is the load-bearing one for misconfigured envs)
 */
export function validateProviderBaseUrl(providerLabel: string, urlStr: string): void {
  const cacheKey = `${providerLabel}${urlStr}`;
  if (_validatedUrls.has(cacheKey)) return;

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`${providerLabel} base URL is malformed: ${urlStr}`);
  }

  const host = parsed.hostname;

  // Scheme check first. Mirrors the private-range pattern below: the
  // escape hatch (CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1) opts in
  // to BOTH http-on-non-localhost and private-range IPs, with a
  // per-(provider, URL, gate) warn-once. Pre-fix the escape hatch only
  // relaxed the IP-range check, which left typical Tailscale-CGNAT-
  // over-http setups unreachable even with the env var set.
  if (parsed.protocol !== 'https:' && !isLocalhostHost(host)) {
    if (escapeHatchEnabled()) {
      const warnKey = `${cacheKey}:scheme`;
      if (!_warnedEscapeHatches.has(warnKey)) {
        _warnedEscapeHatches.add(warnKey);
        process.stderr.write(
          `[cambium] WARNING: ${providerLabel} base URL "${urlStr}" uses non-https scheme. ` +
          `Allowed because CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1 is set. ` +
          `Bearer tokens travel in plaintext on this connection — confirm the network path is trusted (Tailscale, WireGuard, internal VLAN, etc).\n`
        );
      }
    } else {
      throw new Error(
        `${providerLabel} base URL "${urlStr}" uses non-https scheme. ` +
        `Only https:// is allowed for non-localhost hosts (preserves credential-confidentiality posture for bearer-token providers). ` +
        `Set CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1 to opt in if this is an internal-VLAN proxy.`
      );
    }
  }

  // Private-range check. Hostnames pass through (no DNS). Localhost
  // hosts (127.0.0.1, ::1) are also exempt — they passed the scheme
  // check above and shouldn't trip private-range now that 127/8 is
  // in the table.
  const looksLikeIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const looksLikeIPv6 = host.includes(':') || (host.startsWith('[') && host.endsWith(']'));
  const isPrivate = isLocalhostHost(host)
    ? false
    : looksLikeIPv4
      ? isPrivateIPv4(host)
      : looksLikeIPv6
        ? isPrivateIPv6(host)
        : false;

  if (isPrivate) {
    if (escapeHatchEnabled()) {
      if (!_warnedEscapeHatches.has(cacheKey)) {
        _warnedEscapeHatches.add(cacheKey);
        process.stderr.write(
          `[cambium] WARNING: ${providerLabel} base URL "${urlStr}" is in a private/metadata range. ` +
          `Allowed because CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1 is set. ` +
          `Confirm this is intentional — operator-controlled env vars carrying API keys to private endpoints can leak credentials.\n`
        );
      }
    } else {
      throw new Error(
        `${providerLabel} base URL "${urlStr}" resolves to a private/metadata IP range. ` +
        `Refused to send credentials. Set CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1 to opt in if this is an internal-VLAN proxy.`
      );
    }
  }

  _validatedUrls.add(cacheKey);
}

// Test-only: reset the validation cache. Production code never needs this.
export function _resetValidatorCacheForTesting(): void {
  _validatedUrls.clear();
  _warnedEscapeHatches.clear();
}
