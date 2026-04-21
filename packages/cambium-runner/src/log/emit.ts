// ── Log emission (RED-282 / RED-302) ─────────────────────────────────
//
// `emitLogEvent` fans out one event to every configured destination,
// firing each sink async and swallowing errors into `LogFailed` trace
// steps (never propagates — a DD blip should not fail a run).
//
// Called at three sites in the runner outer loop:
//   1. Run complete, finalOk=true, no CorrectAcceptedWithErrors:
//        event: 'complete'
//   2. Run complete, finalOk=true, any CorrectAcceptedWithErrors present:
//        event: 'complete_with_warnings'
//   3. Run failed (finalOk=false):
//        event: 'failed', with reason derived from the failure class
//
// The caller (runner.ts) builds the base event from run state, passes
// the resolved destinations from ir.policies.log, the per-call sink
// registry (builtin ∪ app plugin ∪ opts), and a trace-push callback
// so LogEmitted / LogFailed steps land in the right trace.

import { builtinLogSinks } from './index.js';
import type { LogEvent, LogSink, LogDestination } from './event.js';

/** Snake-case a class name: PatternExtractor → pattern_extractor. */
export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Build a run-level log event from run state. Caller picks the event
 *  kind + optional reason based on the run outcome. Framework-always
 *  fields are populated here; profile-configurable fields (signals,
 *  tool_calls, etc.) are extracted from the trace and merged in. */
export function buildRunLogEvent(args: {
  genClass: string;
  method: string;
  event: 'complete' | 'complete_with_warnings' | 'failed';
  runId: string;
  ok: boolean;
  schemaId?: string;
  durationMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  traceRef?: string;
  reason?: 'budget_exceeded' | 'validation_failed' | 'schema_broke_after_corrector' | 'error';
  trace?: any;
  firedBy?: 'schedule';
}): LogEvent {
  const gen = snakeCase(args.genClass);
  const event: LogEvent = {
    event_name: `${gen}.${args.method}.${args.event}`,
    gen,
    method: args.method,
    event: args.event,
    run_id: args.runId,
    ok: args.ok,
  };
  if (args.durationMs != null) event.duration_ms = args.durationMs;
  if (args.schemaId) event.schema_id = args.schemaId;
  if (args.usage) event.usage = args.usage;
  if (args.traceRef) event.trace_ref = args.traceRef;
  if (args.reason) event.reason = args.reason;
  if (args.firedBy) event.fired_by = args.firedBy;

  // Opt-in profile fields derived from the trace.
  if (args.trace?.steps) {
    const signals = extractSignals(args.trace);
    if (signals) event.signals = signals;
    const toolCalls = countToolCalls(args.trace);
    if (toolCalls) event.tool_calls = toolCalls;
    const repairAttempts = countRepairs(args.trace);
    if (repairAttempts > 0) event.repair_attempts = repairAttempts;
    const errors = extractErrors(args.trace);
    if (errors) event.errors = errors;
    const outputSummary = extractOutputSummary(args.trace);
    if (outputSummary) event.output_summary = outputSummary;
  }
  return event;
}

function extractSignals(trace: any): Record<string, unknown> | undefined {
  const signalSteps = (trace.steps ?? []).filter((s: any) => s.type === 'ExtractSignals');
  if (signalSteps.length === 0) return undefined;
  // Merge meta.signals across all ExtractSignals steps — later overwrites earlier.
  const out: Record<string, unknown> = {};
  for (const s of signalSteps) {
    if (s.meta?.signals && typeof s.meta.signals === 'object') {
      Object.assign(out, s.meta.signals);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function countToolCalls(trace: any): Record<string, number> | undefined {
  const toolCallSteps = (trace.steps ?? []).filter((s: any) => s.type === 'ToolCall');
  if (toolCallSteps.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const s of toolCallSteps) {
    const name = String(s.meta?.tool ?? s.tool ?? 'unknown');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function countRepairs(trace: any): number {
  return (trace.steps ?? []).filter((s: any) => s.type === 'Repair').length;
}

function extractOutputSummary(trace: any): string | undefined {
  // Walk trace in reverse to find the last Generate step; its raw is
  // the most recent candidate output. Truncate to 1kb so we don't ship
  // a full multi-MB output to every log destination.
  const steps = trace.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === 'Generate' && typeof s.meta?.raw_preview === 'string') {
      return s.meta.raw_preview.slice(0, 1024);
    }
  }
  return undefined;
}

function extractErrors(trace: any): unknown[] | undefined {
  const failedSteps = (trace.steps ?? []).filter(
    (s: any) => s.ok === false && (s.errors || s.meta?.errors || s.meta?.reason),
  );
  if (failedSteps.length === 0) return undefined;
  return failedSteps.map((s: any) => ({
    type: s.type,
    errors: s.errors ?? s.meta?.errors ?? s.meta?.reason,
  }));
}

/** Determine the right event + reason from final run state. */
export function classifyRunOutcome(
  finalOk: boolean,
  trace: any,
  budgetExceeded: boolean,
): {
  event: 'complete' | 'complete_with_warnings' | 'failed';
  reason?: 'budget_exceeded' | 'validation_failed' | 'schema_broke_after_corrector' | 'error';
} {
  if (budgetExceeded) return { event: 'failed', reason: 'budget_exceeded' };
  if (!finalOk) {
    // Walk trace in reverse; first ok:false step tells us why.
    const steps = trace.steps ?? [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.ok === false) {
        if (s.type === 'ValidateAfterCorrect') {
          return { event: 'failed', reason: 'schema_broke_after_corrector' };
        }
        return { event: 'failed', reason: 'validation_failed' };
      }
    }
    return { event: 'failed', reason: 'error' };
  }
  // finalOk true — check for CorrectAcceptedWithErrors.
  const hasWarning = (trace.steps ?? []).some(
    (s: any) => s.type === 'CorrectAcceptedWithErrors',
  );
  return { event: hasWarning ? 'complete_with_warnings' : 'complete' };
}

export interface EmitLogContext {
  /** All destinations declared on this gen via ir.policies.log. */
  destinations: LogDestination[];
  /** Full sink registry for this runGen call — already merged from
   *  builtins + app plugins + opts.logSinks. */
  sinks: Record<string, LogSink>;
  /** Callback to push a LogEmitted / LogFailed step into the trace. */
  pushStep: (step: any) => void;
}

/**
 * Fan out `event` to every destination in `ctx.destinations`. For each:
 *
 *   - Filter the event payload to `framework-always ∪ destination.include`.
 *   - Look up the sink by `destination.name` in `ctx.sinks`.
 *   - Fire the sink async; on success emit `LogEmitted`, on failure
 *     emit `LogFailed` (never propagates).
 *
 * Returns when all dispatches settle. Not awaited in the runner's hot
 * path by default (see emitLogEventFireAndForget below); exposed here
 * for tests that need to assert emission order.
 */
export async function emitLogEvent(
  baseEvent: LogEvent,
  ctx: EmitLogContext,
): Promise<void> {
  // Granularity filter: step-level events only go to `granularity: :step`
  // destinations; run-level events go to `granularity: :run` only.
  const stepEventNames = new Set<string>([
    'tool_call', 'repair', 'signal_fired', 'action_call',
    'correct_after_repair', 'correct_accepted_with_errors',
    'validate_after_repair', 'validate_after_correct',
  ]);
  const wantGranularity: 'run' | 'step' =
    stepEventNames.has(baseEvent.event as string) ? 'step' : 'run';

  const tasks: Promise<void>[] = [];
  for (const dest of ctx.destinations) {
    if (dest.granularity !== wantGranularity) continue;

    const sink = ctx.sinks[dest.destination];
    if (!sink) {
      ctx.pushStep({
        type: 'LogFailed',
        ok: false,
        meta: {
          destination: dest.destination,
          event_name: baseEvent.event_name,
          reason: `unknown destination; available: ${Object.keys(ctx.sinks).join(', ')}`,
        },
      });
      continue;
    }

    const payload = filterPayload(baseEvent, dest.include);
    tasks.push(dispatchOne(sink, payload, dest, ctx));
  }

  await Promise.all(tasks);
}

// Note: earlier drafts exported an `emitLogEventFireAndForget` alias
// for the same function, meant to signal "you can skip the await."
// That name was misleading — the runner currently awaits every
// emission at both outcome sites to guarantee LogEmitted/LogFailed
// steps land in the trace before runGen returns. A true background
// flush with separate ordering semantics would warrant a different
// name ("emitLogEventBackground") AND a different code path. Until
// that need surfaces, there's just one function: `emitLogEvent`,
// returning a Promise the caller should await.

/** Build a per-destination payload: framework-always + the destination's
 *  opt-in include fields. Drops anything not in either set. */
function filterPayload(event: LogEvent, include: string[]): LogEvent {
  const frameworkAlways = new Set<string>([
    'event_name', 'gen', 'method', 'event', 'run_id',
    'ok', 'duration_ms', 'schema_id', 'usage', 'trace_ref', 'reason',
    'fired_by',
  ]);
  const allow = new Set<string>([...frameworkAlways, ...include]);
  const out: LogEvent = {} as LogEvent;
  for (const [k, v] of Object.entries(event)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}

async function dispatchOne(
  sink: LogSink,
  payload: LogEvent,
  dest: LogDestination,
  ctx: EmitLogContext,
): Promise<void> {
  try {
    await sink(payload, dest);
    ctx.pushStep({
      type: 'LogEmitted',
      ok: true,
      meta: {
        destination: dest.destination,
        event_name: payload.event_name,
        profile: dest._profile,
      },
    });
  } catch (err: any) {
    ctx.pushStep({
      type: 'LogFailed',
      ok: false,
      meta: {
        destination: dest.destination,
        event_name: payload.event_name,
        profile: dest._profile,
        reason: err?.message ?? String(err),
      },
    });
  }
}

/** Build the initial sink registry: built-ins only. The runner merges
 *  plugin sinks + opts.logSinks on top before passing to emitLogEvent. */
export function baseLogSinks(): Record<string, LogSink> {
  return { ...builtinLogSinks };
}
