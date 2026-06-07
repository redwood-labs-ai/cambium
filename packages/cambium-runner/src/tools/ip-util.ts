/**
 * Shared IPv4/IPv6 canonicalization utilities.
 *
 * Extracted from base-url-validator.ts so both the provider egress checker
 * and the network guard share a single source of truth. Previously the fix
 * for IPv4-mapped IPv6 bypass (::ffff:192.168.1.1) was only applied to
 * base-url-validator.ts; network-guard.ts had the same gap, confirmed as an
 * SSRF bypass in the 2026-06-06 security audit (AUD-001).
 */

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Accepts both forms:
 *   - dotted:    ::ffff:192.168.1.1  (human-written)
 *   - hex-pair:  ::ffff:c0a8:101     (Node's URL parser canonical form)
 *
 * Returns null if the input is not an IPv4-mapped IPv6 address.
 */
export function extractIPv4MappedV6(s: string): string | null {
  const lower = s.toLowerCase();
  // Dotted form: ::ffff:a.b.c.d
  const dottedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) return dottedMatch[1];
  // Hex-pair form that Node's URL constructor normalises to: ::ffff:HHHH:HHHH
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
