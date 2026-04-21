// ── Log backend: datadog (RED-282 / RED-302) ─────────────────────────
//
// Purpose-built for Datadog's log intake. Does four things the
// generic http_json doesn't:
//
// 1. Sets `ddsource: cambium` and `ddtags: gen:<snake>,method:<snake>,ok:<bool>`
//    so DD's indexed-tag filters work immediately (`@ddtags:"gen:pattern_extractor"`).
// 2. Credential header uses `DD-API-KEY: <key>` rather than bearer,
//    per DD's HTTP API spec.
// 3. Flattens nested `usage.{prompt,completion,total}_tokens` into
//    `usage_prompt_tokens` etc. at the top level — DD indexes flat
//    scalar fields efficiently; nested paths cost more and are harder
//    to pivot on.
// 4. Maps the framework event taxonomy (`complete` /
//    `complete_with_warnings` / `failed`) to DD's `status` field
//    (`info` / `warn` / `error`). Without this mapping every event
//    lands as the DD default (`info`), breaking severity facets and
//    monitor queries like `status:error`. See `mapDatadogStatus`.
//
// Endpoint default: `https://http-intake.logs.datadoghq.com/api/v2/logs`
// (US1 region). Non-US operators set `endpoint:` in the profile.
// Credential env var defaults to `CAMBIUM_DATADOG_API_KEY`.

import type { LogEvent, LogSink } from '../event.js';
import { guardLogEndpoint } from '../guard.js';

const DEFAULT_ENDPOINT = 'https://http-intake.logs.datadoghq.com/api/v2/logs';
const DEFAULT_API_KEY_ENV = 'CAMBIUM_DATADOG_API_KEY';

export const datadog: LogSink = async (event, dest) => {
  const endpoint = dest.endpoint ?? DEFAULT_ENDPOINT;
  const apiKeyEnv = dest.api_key_env ?? DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `log :datadog: ${apiKeyEnv} env var not set. Cannot authenticate to Datadog.`,
    );
  }

  // Pre-flight SSRF guard: blocks cloud-metadata addresses. DD's own
  // endpoints are public, so this is effectively a no-op for legitimate
  // use; the guard catches a gen that overrode endpoint: to something
  // hostile.
  await guardLogEndpoint(endpoint);

  const body = {
    ddsource: 'cambium',
    ddtags: buildTags(event),
    service: event.gen,
    status: mapDatadogStatus(event),
    ...flattenEvent(event),
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `log :datadog POST to ${endpoint} failed: HTTP ${res.status}`,
    );
  }
};

function buildTags(event: any): string {
  const tags: string[] = [
    `gen:${event.gen}`,
    `method:${event.method}`,
    `event:${event.event}`,
    `ok:${String(event.ok)}`,
  ];
  if (event.reason) tags.push(`reason:${event.reason}`);
  // RED-305: scheduled-run filter. `fired_by:schedule` lets DD monitors
  // distinguish cron-fired failures from interactive ones.
  if (event.fired_by) tags.push(`fired_by:${event.fired_by}`);
  return tags.join(',');
}

// Flatten nested `usage.{prompt,completion,total}_tokens` → top-level
// `usage_prompt_tokens` etc. so DD indexes them as scalar fields.
// Leaves other nested objects (signals, tool_calls) alone — those are
// genuinely nested data that DD users would query via JSONPath anyway.
function flattenEvent(event: any): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  if (event.usage && typeof event.usage === 'object') {
    delete out.usage;
    for (const [k, v] of Object.entries(event.usage)) {
      out[`usage_${k}`] = v;
    }
  }
  return out;
}

/**
 * Map a framework event to Datadog's `status` field.
 *
 * DD's log status drives severity facets (`@status:error`), monitor
 * queries, and dashboard grouping. Without an explicit value DD
 * defaults everything to `info`, so framework-owned failures silently
 * collapse into the same bucket as successes and no monitor can key
 * off run health without brittle message-text matching.
 *
 * The taxonomy is intentionally narrow — same stance as the framework
 * event vocabulary (see `C - Trace (observability).md`). Adding a new
 * event type means extending this mapping, not letting operators
 * override per-shop.
 *
 * Run-level:
 *   `complete`               → info
 *   `complete_with_warnings` → warn   (CorrectAcceptedWithErrors, etc.)
 *   `failed`                 → error  (all reasons: budget_exceeded,
 *                                      validation_failed,
 *                                      schema_broke_after_corrector,
 *                                      error)
 *
 * Step-level (for forward compatibility when `granularity: :step`
 * starts emitting):
 *   `correct_accepted_with_errors` → warn   (unhealed-but-shippable)
 *   anything else                  → info   (normal run progress)
 *
 * Note: `LogFailed` is a trace-step-only artifact pushed by
 * `emitLogEvent` itself when a sink dispatch throws; it is never fed
 * back through the log fan-out (a failing sink routing its own
 * failures to the same sink would be a retry loop). So there is no
 * `log_failed` case here — sink outages surface in `trace.json` only.
 *
 * Returns canonical spelled-out values (`info` / `warn` / `error`).
 * DD accepts several aliases; canonical forms are stable across DD
 * API versions.
 */
export function mapDatadogStatus(event: LogEvent): 'info' | 'warn' | 'error' {
  switch (event.event) {
    case 'complete':
      return 'info';
    case 'complete_with_warnings':
      return 'warn';
    case 'failed':
      return 'error';
    case 'correct_accepted_with_errors':
      return 'warn';
    default:
      return 'info';
  }
}
