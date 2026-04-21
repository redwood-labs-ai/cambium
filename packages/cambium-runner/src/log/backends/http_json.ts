// ── Log backend: http_json (RED-282 / RED-302) ───────────────────────
//
// Generic POST to any endpoint with a JSON body. Auth is optional —
// if `api_key_env` is set, the value (read from process.env at
// dispatch time) goes as `Authorization: Bearer <value>`. Endpoint
// is required — without it there's nowhere to send.
//
// For Datadog-specific shaping use `:datadog`; this is the catch-all
// for "platform X accepts a JSON webhook."

import type { LogSink } from '../event.js';
import { guardLogEndpoint } from '../guard.js';

export const http_json: LogSink = async (event, dest) => {
  if (!dest.endpoint) {
    throw new Error(
      `log :http_json: missing endpoint. Set via profile destination or inline \`endpoint:\` option.`,
    );
  }

  // Pre-flight SSRF guard: blocks cloud-metadata addresses. Allows
  // RFC1918 private ranges so internal-ingest endpoints work.
  await guardLogEndpoint(dest.endpoint);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (dest.api_key_env) {
    const token = process.env[dest.api_key_env];
    if (!token) {
      // Mirror `:datadog`'s hard-throw behavior: if the author declared
      // an auth env var, a missing value is a misconfiguration worth
      // surfacing, not a silent no-auth request. Symmetry with the DD
      // backend is the goal.
      throw new Error(
        `log :http_json: ${dest.api_key_env} env var not set. ` +
        `Unset api_key_env entirely if the endpoint accepts unauthenticated POSTs.`,
      );
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(dest.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    throw new Error(
      `log :http_json POST to ${dest.endpoint} failed: HTTP ${res.status}`,
    );
  }
};
