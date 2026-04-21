## Note: `log` Primitive — Trace Destination Fan-Out

**Doc ID:** gen-dsl/note/log-primitive
**Status:** Draft (RED-282)
**Last edited:** 2026-04-21

---

## Purpose

Cambium's observability today is `runs/<run_id>/trace.json` per run — rich, structured, file-per-run. Great for debugging a specific run, useless for production visibility: no aggregation across runs, no shipment to Datadog / Honeycomb / Sentry, no alerting on "validation-failed runs are up 20% this hour." Operators have to scrape `runs/` and ship themselves — the kind of plumbing a framework should own.

This note specs a `log` primitive that closes the gap. The framing is load-bearing: **`log` is a fan-out destination for the existing trace**, not a new log event system. Gens declare where their trace should also go; the runner emits run-level (and optionally step-level) events to each destination with framework-owned vocabulary and opinionated defaults.

---

## Grounding

The forcing case is Datadog ingestion for downstream products (curator-class apps) that need full run auditability + immediate human readability in the DD UI. Without this primitive, every app bolts together a custom trace → DD forwarder, duplicates the same payload logic, and diverges on event vocabulary — the exact DRY violation that motivated the framework bet in the first place.

---

## Decisions

### 1. Reframe: trace-fan-out, not new event system

`log` emits structured events derived from the trace, not an independent log stream. Payload shape is anchored on the trace's existing data model; adding a new log event is adding a new trace step type (or deriving from existing ones), nothing else. Consequences:

- No parallel event vocabulary to maintain.
- Step-level granularity (opt-in) literally mirrors trace step types.
- Redaction happens at the forwarder layer (same trace in, redacted shape out).
- The `log` primitive's DSL surface stays tiny because most of the data plumbing is pre-existing.

### 2. Dot-notation event names — `<gen>.<method>.<event>`

Precedent: ActiveSupport::Notifications (`process_action.action_controller`, `sql.active_record`). Three-dot namespacing makes DD filters tractable:

```
@event_name:pattern_extractor.*.failed      # every pattern extractor failure across methods
@event_name:*.extract.budget_exceeded       # every budget trip, any gen
@event_name:pattern_extractor.extract.*     # everything about one gen-method combo
```

All three slots are snake_case-normalized:

- `<gen>` — snake-cased class name. `PatternExtractor` → `pattern_extractor`.
- `<method>` — the method the gen's IR declared (`extract`, `analyze`, `summarize`).
- `<event>` — framework-owned vocabulary (see §3).

Names match `/^[a-z][a-z0-9_]*$/` — same regex Cambium already enforces for corrector names, tool names, pool names, pack names. Existing invariant, extended.

### 3. Framework-owned event vocabulary

Users do not invent event names. The taxonomy is fixed and small:

**Run-level** (always emitted when `log` is declared):

| event | When | `ok` |
| --- | --- | --- |
| `complete` | Run finished with `finalOk: true` and no corrector terminal-error state | true |
| `complete_with_warnings` | Run finished with `finalOk: true` but at least one `CorrectAcceptedWithErrors` step present (RED-298) | true |
| `failed` | Run finished with `finalOk: false`. Payload `reason` field distinguishes `validation_failed` / `budget_exceeded` / `schema_broke_after_corrector` / `error`. | false |

**Step-level** (emitted only when `granularity: :step` is set, opt-in):

- `tool_call`, `repair`, `signal_fired`, `action_call`, `correct_after_repair`, `correct_accepted_with_errors`, etc. — literally mirror trace step types, lower-snake-cased.

Adding a new event type requires extending the runner and the C-Trace doc. Apps cannot introduce arbitrary names. The Rails-y opinionated stance: the framework owns the taxonomy so dashboards remain tractable across shops.

### 4. Field layers — framework-always + profile-configurable

Two tiers. Framework-always ships in every event regardless of profile:

- `run_id`, `gen`, `method`, `event`
- `ok`, `duration_ms`, `schema_id`
- `usage.{prompt_tokens, completion_tokens, total_tokens}`
- `trace_ref` — file-path or URL pointer to the authoritative trace.json for deep-dive

Profile-configurable (via `app/log_profiles/<name>.log_profile.rb` `include:` keyword):

- `signals` — extracted signal values
- `output_summary` — truncated output snapshot
- `tool_calls` — per-tool dispatch counts
- `repair_attempts` — how many repairs fired (quality signal)
- `errors` — validation errors when `ok: false`

Framework-always is the critical ops telemetry — never opt-out. Profile-configurable is the "opt into richer payloads when PII / cost allows" escape hatch. Empty profile (include nothing) is the safest default.

### 5. Policy profile pattern — `app/log_profiles/<name>.log_profile.rb`

Mirrors RED-214 (policy packs) and the structural invariant that every tool / agent / policy / pool gets its own file. A profile bundles destinations + field configuration + granularity:

```ruby
# app/log_profiles/app_default.log_profile.rb
Cambium::Log.define :app_default do
  destination :datadog, endpoint: ENV["DD_LOG_INTAKE_URL"], api_key_env: "CAMBIUM_DATADOG_API_KEY"
  destination :stdout
  include :signals, :usage, :repair_attempts
  granularity :run
end
```

Gens reference by symbol, same per-slot mixing rules as RED-214 security packs — either a pack or inline, not both in one `log` call:

```ruby
class PatternExtractor < Cambium::GenModel
  log :app_default                              # full profile reference
  # OR
  log :datadog, include: [:signals, :usage]     # inline form
end
```

Multiple `log` calls accumulate destinations — same stance as `uses :a, :b`:

```ruby
log :app_default
log :stdout, include: [:output_summary]   # additional local-dev dump
```

Profile name regex: `/^[a-z][a-z0-9_]*$/`. Path-traversal guard already in the Ruby pattern (RED-214 precedent).

### 6. Backends — three framework-provided + plugin pattern

Framework ships three built-ins:

- `:stdout` — human-readable `[<event>] <key>=<value>...` text. For local dev and ops-station tailing.
- `:http_json` — generic POST to any URL with a JSON body. Configure endpoint via profile. Catches every "my platform accepts JSON" case.
- `:datadog` — purpose-built. POSTs to DD's log intake (`https://http-intake.logs.datadoghq.com/api/v2/logs`), sets `ddsource: cambium`, `ddtags: gen:<snake>,method:<snake>,ok:<bool>`, flattens the trace payload for DD's indexed-field model, and maps the framework event taxonomy to DD's `status` field (see [[P - log]] § Datadog status mapping) so severity facets and monitor queries work out of the box. Credential via `CAMBIUM_DATADOG_API_KEY` (or `api_key_env:` profile override).

Plugin pattern mirrors RED-209 (tools) and RED-275 (correctors). App ships `app/logs/<name>.log.ts` exporting a `LogSink` function:

```ts
// app/logs/honeycomb.log.ts
import type { LogSink } from '@cambium/runner';

export const honeycomb: LogSink = async (event, ctx) => {
  // ... POST to Honeycomb, handle auth, etc.
};
```

Plugin precedence: app plugin > framework built-in (same override hook as tools / correctors — with the one-time stderr override warning).

---

## Rationale

### Why trace-fan-out beats a new event system

The original ticket framing ("add a `log` primitive that emits events") invites a parallel event schema. That's the expensive version: now there are two structured data models (trace + log), and they'll drift. Reframing as "fan out the trace" is smaller, composes with existing tooling, and means shops that later want to ship trace.json directly to S3 or BigQuery get it essentially for free.

### Why framework-owned event vocabulary

The temptation is to let gens emit `log "user_clicked_button_x"` or similar app-specific names. Rejected — that path produces the classic enterprise-observability failure mode where every team invents their own event taxonomy and the DD dashboards become unsearchable. The Cambium bet is "framework owns the vocabulary; apps own the payload richness" — same stance as "framework owns the DSL; apps own the gen logic."

New event types get added at framework-release cadence, not app cadence. Callers who feel constrained can always emit a trace step from within a tool and let step-level granularity carry it.

### Why env-var credentials + profile endpoint split

Parallel to `CAMBIUM_OMLX_API_KEY` (RED-137): secrets in env vars, never in committed config. The profile declares `api_key_env: "CAMBIUM_DATADOG_API_KEY"` — the runner reads the env var at dispatch time. Endpoint URLs are safe to commit (regional DD ingest hosts, private VPC endpoints) and live in the profile file.

### Why run-level default

A busy gen under step-level granularity can emit 50+ events per run. That's useful for deep debugging but catastrophic for a DD bill or an alert-on-failure dashboard. Run-level (one event per run) is what every ops team actually wants indexed. Step-level is the opt-in firehose — same stance Cambium takes everywhere else about "declare the default, opt into the detail."

---

## Rejected alternatives

- **Per-gen inline credentials** (`log :datadog, api_key: ENV["..."]`). Rejected: clutters gens, invites mistakes (raw string literals for secrets), doesn't scale to 10 gens sharing one profile. Profile-level with env-var reference is the right layer.
- **User-defined event names.** Rejected as above — tragedy of the commons for dashboards.
- **Mandatory full-trace shipment.** Considered for the "just send everything" stance. Rejected: full trace.json is tens-of-KB per run, DD indexes ~1KB efficiently, the cost model breaks fast. Run-level summary + `trace_ref` pointer is the right tradeoff (ship the index key, host the blob locally).
- **Synchronous ingest.** Rejected — a DD blip should never fail a run. All sinks are fire-and-forget async; failures emit a `log.failed` trace step and don't propagate.
- **Buffered/retrying sink.** Disk-backed queue for "DD is down, ship when it recovers." Rejected for v1 as premature complexity. Fire-and-forget + trace record of the failure is enough; operators who need durability add a sidecar.
- **Single-call `log :a, :b` as list-of-backends.** Considered as shorthand for `log :a; log :b`. Rejected because it muddies the profile-vs-inline per-slot rule. Multiple `log` calls is cleaner and matches `uses :a, :b` / `corrects :a, :b` shape.

---

## Open questions (defer to impl ticket)

1. **Failure-event payload shape.** `failed.reason` is a string today (`validation_failed`, etc.) — should it be structured (`reason: { kind: "budget_exceeded", metric: "tokens", at: 1200 }`)? Lean structured but the impl ticket nails it down with one real DD dashboard's constraints in hand.
2. **Sampling.** `log :datadog, sample: 0.1` deferred to v1.5. Most shops hit DD's own sampling first; don't duplicate the knob prematurely.
3. **Trigger overlap.** A trigger can already do `on_complete { action :datadog_emit, ... }` (RED-212). The `log` primitive doesn't *replace* that; it's the declarative easy-button. Triggers remain the escape hatch for conditional emission. No new design work; cross-reference in P-log.md.
4. **`:memory`-strategy naming collision.** `memory :activity, strategy: :log` (RED-215 phase 2) is an in-process memory strategy; the `log` primitive ships events to external platforms. Different problems, unfortunate word overlap. P-log.md includes a disambiguation callout.

---

## Implementation sketch

See the impl ticket (filed as a follow-up) for the mechanical walkthrough. Shape:

### Ruby DSL (`ruby/cambium/runtime.rb`)

```ruby
def log(destination_or_profile, **opts)
  # validate profile-vs-inline mutual exclusion per RED-214 pattern
  # append to _cambium_defaults[:log] as { destination|profile, include, granularity, endpoint?, api_key_env? }
end
```

### IR shape (`ruby/cambium/compile.rb`)

```json
{
  "policies": {
    "log": [
      {
        "profile": "app_default",
        "granularity": "run",
        "include": ["signals", "usage", "repair_attempts"]
      }
    ]
  }
}
```

When profile-referenced: resolve profile at compile time, inline the destinations + include list. Runner sees only fully-resolved entries (same stance as RED-214 policy packs — `_packs: [...]` metadata preserves the source for trace observability).

### Runner (`packages/cambium-runner/src/runner.ts`)

- New `emitLogEvent(event, extraFields, logDests)` helper after `runGen`'s outer try/catch.
- Fire at three sites:
  - Run completion (success, `complete` or `complete_with_warnings`)
  - Run failure (in the outer catch block that converts BudgetExceededError / schema-fail to `finalOk: false`)
  - Step events (opt-in `granularity: :step`, fires at each trace-step push)
- Each emission fans out to every configured destination. Fire-and-forget async; errors emit `log.failed` trace step, don't propagate.

### Workspace config (`packages/cambium-runner/src/log/profile-loader.ts`)

- `loadLogProfile(baseDir, profileName)` scans `app/log_profiles/<name>.log_profile.rb`, instance_evals inside `Cambium::Log::ProfileBuilder`, returns the destinations + include list.
- Name regex + realpath escape guard + `CompileError` wrapping — copy from `MemoryPool.load` (RED-215) / `PolicyPack.load` (RED-214).

### Backend adapters (`packages/cambium-runner/src/log/backends/*`)

Three framework built-ins: `stdout.ts`, `http_json.ts`, `datadog.ts`. Each exports a `LogSink: (event, ctx) => Promise<void>`. Plugin pattern scans `app/logs/*.log.ts` at runner startup, same discovery logic as RED-209 tools.

### Tests

- Compile-time: profile-vs-inline mutual exclusion raises, granularity in `[:run, :step]`, include list validates against known field names.
- Runtime: mock HTTP server captures POST bodies, asserts framework-always fields present, event names snake-cased correctly, destination list honored.
- Integration: tmpdir workspace with `app/log_profiles/test_default.log_profile.rb` + a gen declaring `log :test_default` + spawn CLI + mock DD server receives the event.

---

## Out of scope

- **Sampling beyond DD's own.** Deferred; if a shop hits it, file a follow-up.
- **Bundled backends beyond the three built-ins.** Honeycomb, Sentry, Axiom, OpenObserve, etc. are all plugin candidates. Ship one (DD) + the plugin pattern; let shops / the community fill in the rest.
- **Structured retry / buffering.** Fire-and-forget + trace record is v1. Durable sinks are a v1.5+ concern.
- **Cost-tracking math for non-OpenAI-compatible providers.** Relies on per-provider pricing tables; separate concern from the primitive itself.
- **Trigger-to-`log` migration path.** Triggers with `action :datadog_emit` keep working; the `log` primitive is additive, not a replacement. Same-project coexistence is fine.

---

## See also

- [[P - corrects (correctors)]] — plugin pattern precedent
- [[C - Trace (observability)]] — the source of truth for log event vocabulary
- [[P - Memory]] — the `:log` memory strategy (confusingly named, not what this primitive does)
- [[N - App Mode vs Engine Mode (RED-220)]] — engine-mode host observability
- RED-214 — policy pack pattern (profile file shape)
- RED-137 — `CAMBIUM_*_API_KEY` env var convention for credentials
- RED-212 — triggers (conditional emission escape hatch)
