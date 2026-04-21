// ── Log primitive: module barrel (RED-282 / RED-302) ─────────────────
//
// Public surface for `@redwood-labs/cambium-runner` hosts that want to build their
// own log-sink maps (mirrors the RED-299 correctors shape).

import { stdout } from './backends/stdout.js';
import { http_json } from './backends/http_json.js';
import { datadog } from './backends/datadog.js';
import type { LogSink } from './event.js';

export type { LogEvent, LogSink, LogDestination, RunEventName, FailReason } from './event.js';
export { emitLogEvent, snakeCase, baseLogSinks, buildRunLogEvent, classifyRunOutcome } from './emit.js';
export { loadAppLogSinks } from './plugin-loader.js';
export type { AppLogPluginLoadResult } from './plugin-loader.js';

/** Framework-built-in log sinks. Read-only; hosts merge their own on
 *  top via `{ ...builtinLogSinks, ...host_map }`. Matches the
 *  RED-299 `builtinCorrectors` convention. */
export const builtinLogSinks: Readonly<Record<string, LogSink>> = Object.freeze({
  stdout, http_json, datadog,
});
