// ── Log backend: datadog (RED-282 / RED-302) ─────────────────────────
//
// Purpose-built for Datadog's log intake. Does three things the
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
//
// Endpoint default: `https://http-intake.logs.datadoghq.com/api/v2/logs`
// (US1 region). Non-US operators set `endpoint:` in the profile.
// Credential env var defaults to `CAMBIUM_DATADOG_API_KEY`.

import type { LogSink } from '../event.js';
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
