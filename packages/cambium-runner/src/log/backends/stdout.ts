// ── Log backend: stdout (RED-282 / RED-302) ──────────────────────────
//
// Human-readable text output on stderr (not stdout — the gen's own
// stdout carries the validated output JSON, and mixing log lines into
// it would break `cambium run ... | jq`). Prints one line per event:
//
//   [pattern_extractor.extract.complete] ok=true duration_ms=1243 ...
//
// Flat key=value format is intentional — no JSON here. The user runs
// this for `tail -f` local dev; structured storage is what the other
// backends are for.

import type { LogSink } from '../event.js';

export const stdout: LogSink = (event) => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (key === 'event_name') continue;
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  process.stderr.write(`[${event.event_name}] ${parts.join(' ')}\n`);
};

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
