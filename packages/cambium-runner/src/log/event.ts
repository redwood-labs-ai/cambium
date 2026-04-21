// ── Log primitive: event shape + sink interface (RED-282 / RED-302) ──
//
// The `log` primitive is trace-fan-out, not a new event system.
// Payload derives from run state + trace steps; adding a new event
// type means extending the vocabulary here and wiring the emission
// site in runner.ts. Users do NOT introduce arbitrary event names —
// the framework owns the taxonomy (see design note).

/** Run-level event names. Framework-owned vocabulary. */
export type RunEventName =
  | 'complete'
  | 'complete_with_warnings'
  | 'failed';

/** Step-level event names mirror trace step types, opt-in via
 *  `granularity :step`. This list is illustrative, not exhaustive —
 *  step emission re-uses the exact trace step type lowercased + snake
 *  cased. Adding a new trace step type automatically becomes a valid
 *  step-level event name. */
export type StepEventName = string;

/** Reason field on `failed` events. Distinguishes failure classes so
 *  DD dashboards can filter `@reason:budget_exceeded` etc. */
export type FailReason =
  | 'budget_exceeded'
  | 'validation_failed'
  | 'schema_broke_after_corrector'
  | 'error';

/** A single log event. Fields below `[key: string]` are framework-
 *  always; any additional fields come from the profile's `include:`
 *  list (e.g. `signals`, `output_summary`, `tool_calls`, etc.). */
export interface LogEvent {
  /** Full dot-notation event identifier: `<gen>.<method>.<event>`. */
  event_name: string;
  /** Snake-cased gen class name (e.g. `pattern_extractor`). */
  gen: string;
  /** Gen method invoked. */
  method: string;
  /** Event kind within the framework vocabulary. */
  event: RunEventName | StepEventName;
  /** Run identifier — matches `runs/<run_id>/`. */
  run_id: string;
  /** Final OK status. For step-level events, reflects the current
   *  state, not the final run status. */
  ok: boolean;
  /** Wall-clock duration in ms. For step-level events, per-step ms. */
  duration_ms?: number;
  /** Schema $id of the validated output. */
  schema_id?: string;
  /** Token usage aggregated over the run (or the step). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Path or URL pointing to the authoritative trace.json. */
  trace_ref?: string;
  /** Reason field on `failed` events. */
  reason?: FailReason;
  /** RED-305: `"schedule"` when this event was emitted for a run fired
   *  by a cron schedule (i.e. `--fired-by schedule:<id>` was set on the
   *  run). Absent for interactive runs. DD backend surfaces this as a
   *  `fired_by:schedule` ddtag; human readers see the flat field. */
  fired_by?: 'schedule';
  /** Additional profile-configured fields. */
  [key: string]: unknown;
}

/** A log destination's resolved config after IR normalization. */
export interface LogDestination {
  destination: string;
  include: string[];
  granularity: 'run' | 'step';
  endpoint?: string;
  api_key_env?: string;
  _profile?: string;
}

/** Backend handler signature. Framework built-ins (stdout, http_json,
 *  datadog) and app plugins both implement this. Errors from a sink
 *  MUST NOT propagate — the runner wraps each dispatch and emits a
 *  `log.failed` trace step on failure so the run continues. */
export type LogSink = (event: LogEvent, dest: LogDestination) => void | Promise<void>;
