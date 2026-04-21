# Primitive: log

**Doc ID:** gen-dsl/primitive/log

## Purpose

Fan out run-level (and optionally step-level) events from the trace to external observability platforms — Datadog, Honeycomb, Sentry, stdout for local dev, or any JSON-ingest HTTP endpoint. The primitive is intentionally small: `log` declares *where* trace data goes, not a new event schema. Payload derives from existing trace steps. Design note: [[N - Log Primitive (RED-282)]].

## Semantics (normative)

- A gen declares one or more log destinations. Each `log` call adds one destination (or one profile's worth of destinations). Multiple calls accumulate.
- Event names are `<gen>.<method>.<event>` — snake-cased class name, method name, framework-owned event kind. E.g. `pattern_extractor.extract.complete`.
- Event vocabulary (run-level): `complete`, `complete_with_warnings` (emitted when any `CorrectAcceptedWithErrors` step is present), `failed` (with a `reason` field).
- Event vocabulary (step-level, opt-in `granularity: :step`): mirrors trace step types (`tool_call`, `repair`, `signal_fired`, etc.). Framework owns the taxonomy; apps cannot introduce arbitrary names.
- **Fire-and-forget async.** Sink errors emit a `LogFailed` trace step but do NOT fail the run. A Datadog outage must not stop a gen.
- **Framework-always fields** present in every event: `event_name` (the primary `<gen>.<method>.<event>` routing key), `run_id`, `gen`, `method`, `event`, `ok`, `duration_ms`, `schema_id`, `usage.{prompt,completion,total}_tokens`, `trace_ref`.
- **Profile-configurable fields** (via `include:`): `signals`, `output_summary`, `tool_calls`, `repair_attempts`, `errors`.
- Trace carries `LogEmitted` (success) and `LogFailed` (sink error) steps per-destination per-event.

## Forms

### Profile form

```ruby
log :app_default
```

Resolves from `app/log_profiles/app_default.log_profile.rb` (same per-package discovery as `memory_pools` / `policies`). The profile file declares destinations + field configuration + granularity; gens inherit the whole bundle.

### Inline form

```ruby
log :datadog, include: [:signals, :repair_attempts], granularity: :run
log :stdout
log :http_json, endpoint: "https://ingest.example.com/events", api_key_env: "MY_HTTP_KEY"
```

Destination name is a Symbol; framework built-ins resolve to their adapters, app plugins under `app/logs/<name>.log.ts` fill in any custom name.

### Mutex

Within a single `log` call, profile form and inline opts are mutually exclusive — passing both raises a Ruby compile error. Use two calls if you need a profile plus extra destinations:

```ruby
log :app_default                       # ship to DD + stdout (per profile)
log :http_json, endpoint: "...", ...   # also mirror to a private sink
```

## Framework built-in destinations

| Name | Behavior |
| --- | --- |
| `:stdout` | Human-readable text per event, printed to stderr (stderr so stdout stays reserved for the gen's output JSON). Local-dev default. |
| `:http_json` | Generic POST with a JSON body to the configured `endpoint`. Optional `Authorization: Bearer <env-var>` header via `api_key_env:`. |
| `:datadog` | POSTs to DD's log intake with `ddsource: cambium`, `ddtags: gen:<snake>,method:<snake>,event:<kind>,ok:<bool>[,reason:<reason>]`, flattens `usage.*` into top-level `usage_*` fields for DD's indexed-field model. Credential via `DD-API-KEY` header, env var `CAMBIUM_DATADOG_API_KEY` by default. |

## App log plugins

Drop a file at `app/logs/<name>.log.ts` exporting a function named `<name>` that matches the `LogSink` type:

```ts
// app/logs/honeycomb.log.ts
import type { LogSink } from '@cambium/runner';

export const honeycomb: LogSink = async (event, dest) => {
  // POST to Honeycomb's batch-events endpoint, etc.
};
```

Auto-discovered at runner startup. Name must match `/^[a-z][a-z0-9_]*$/`; the basename must equal the exported binding. App plugins override framework built-ins with the same name (one-time stderr warning, same hook as RED-209 tools / RED-275 correctors).

## Profile file shape

```ruby
# app/log_profiles/app_default.log_profile.rb
destination :datadog,
  endpoint: ENV["DD_LOG_INTAKE_URL"],
  api_key_env: "CAMBIUM_DATADOG_API_KEY"
destination :stdout
include :signals, :repair_attempts
granularity :run
```

Validation at load time:

- Profile name matches `/^[a-z][a-z0-9_]*$/`.
- At least one `destination` is required.
- `include :foo` fields must be in `{:signals, :output_summary, :tool_calls, :repair_attempts, :errors}`.
- `granularity` must be `:run` or `:step`.

Path-traversal guard + realpath check mirror `PolicyPack.load` / `MemoryPool.load`.

## Scaffolding

```bash
cambium new log_profile app_default
```

Creates `app/log_profiles/app_default.log_profile.rb` with a DD-targeting starter body. `cambium lint` validates that every `log :profile` reference in a gen resolves to an existing profile file or framework built-in.

## Granularity

| Value | When each event fires |
| --- | --- |
| `:run` (default) | Once per gen invocation — `complete` / `complete_with_warnings` / `failed` |
| `:step` | Once per trace step — `tool_call`, `repair`, `signal_fired`, `correct_after_repair`, etc. Mirrors trace step types. |

Step-level is the opt-in firehose; most ops dashboards want run-level.

## Failure semantics

- **Sink error** (HTTP 500 from DD, connection refused, API key missing) → `LogFailed` trace step with the reason; run continues, completes, returns its output.
- **Unknown destination name** (typo, missing plugin) → `LogFailed` trace step at emission time; run continues. CLI lint warns at authoring time.
- **Run itself failed** (validation, budget, error) → `failed` event still fires with `reason:` set to the failure class. Ops teams want to alert on failures precisely — don't silently drop.

## Worked examples

### Cost tracking

```ruby
class PatternExtractor < Cambium::GenModel
  log :app_default                     # DD with include: [:usage]
  # ... rest of the gen ...
end
```

DD dashboard: sum `@usage_total_tokens` grouped by `@gen`. Per-gen cost over time without any app-side plumbing.

### Error alerting

```ruby
log :datadog, endpoint: ENV["DD_URL"], api_key_env: "CAMBIUM_DATADOG_API_KEY"
```

DD monitor: `@event_name:*.failed` count > N in 5m → page. Alerts fire on any failure class across every gen.

### Audit trail

```ruby
log :datadog, include: [:signals, :output_summary, :tool_calls]
```

Full per-run audit record for compliance-sensitive gens.

## Interaction with triggers

A trigger can already fire actions on signals (`on :foo do; action :bar; end`). The `log` primitive is the declarative easy-button for the common case ("ship every run's event to DD"); triggers remain the escape hatch for conditional emission (`on :critical_error do; action :datadog_emit, ...; end`). Both coexist — no migration required.

## See also

- [[C - Trace (observability)]] — the trace steps that `log` derives from
- [[N - Log Primitive (RED-282)]] — design rationale
- [[P - Memory]] — note the unrelated `memory :x, strategy: :log` (in-process append-only memory, NOT external shipment)
- [[N - App Mode vs Engine Mode (RED-220)]] — `RunGenOptions.logSinks` for engine-mode hosts
