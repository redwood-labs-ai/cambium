// ── Log backend endpoint guard (RED-302 follow-up) ───────────────────
//
// Log destinations are gen-author-controlled via the IR, same trust
// level as `model.id` or `constrain :review` URLs. In a single-author
// or operator-owned deployment this is fine — the author controls what
// endpoints their own gens ship to.
//
// In a multi-tenant engine-mode host running third-party gens,
// endpoint control becomes an SSRF surface: a hostile gen could point
// `log :http_json, endpoint: "http://169.254.169.254/latest/meta-data/"`
// at the EC2 metadata service and exfiltrate run summaries.
//
// Opinionated defense: block well-known cloud-metadata addresses
// always. Do NOT block RFC1918 private ranges — operators legitimately
// ship logs to internal ingest services at `10.0.0.x` etc.
//
// This matches the `block_metadata=true, block_private=false` shape
// we'd apply if this were a tool dispatch. The reuse is intentional:
// RED-137's `checkAndResolve` is the single source of SSRF-defense
// truth, and log backends should ride on it rather than reinvent.

import { checkAndResolve } from '../tools/network-guard.js';

/**
 * Resolve `url` and reject if any resolved IP falls in the blocked
 * cloud-metadata ranges. Returns the resolved IP on success (log
 * backends use `fetch(url)` with the original hostname, not the
 * resolved IP, for Host-header correctness; the resolution is purely
 * a pre-flight check).
 *
 * Throws a clear Error on denial so the outer emit wrapper converts
 * it to a `LogFailed` trace step with the reason surfaced.
 */
export async function guardLogEndpoint(url: string): Promise<void> {
  const decision = await checkAndResolve(
    url,
    {
      allowlist: ['*'],        // any public host
      denylist: [],
      block_private: false,    // allow internal ingest (10.0.0.x, 192.168.x.x)
      block_metadata: true,    // block EC2/GCP/Azure metadata services
    },
  );
  if (!decision.allowed) {
    throw new Error(
      `log endpoint ${url} blocked: ${decision.reason}` +
      (decision.rule ? ` (rule: ${decision.rule})` : ''),
    );
  }
}
