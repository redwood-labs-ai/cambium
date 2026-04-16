# Runtime: Signals, State, and Triggers

**Doc ID:** gen-dsl/runtime/signals-state-triggers

## Purpose
Enable reactive workflows without giving the model arbitrary tool-calling authority.

The model emits **signals**; the runtime updates **state**; deterministic **triggers** decide what to do (tool calls, retrieval, repair, branching).

This replaces brittle regex-driven parsing with readable, typed extraction primitives.

---

## Key idea
**LLMs propose; programs dispose.**

- The LLM is good at *recognizing* when something is present/needed ("there is a latency measurement")
- The program/runtime is responsible for *deciding actions* and executing tools safely.

---

## Signals
A **signal** is a structured annotation emitted during a run.

Examples:
- `needs_calc(expression)`
- `metric(name, value, unit)`
- `missing_citation(path)`
- `uncertainty(path, score)`

### Semantics (normative)
- Signals MUST be structured (JSON), not free text.
- Signals SHOULD be schema-validated.
- Signals MUST be stored in the trace.

---

## State
**State** is a shared store updated by steps and used by later steps.

Examples of state entries:
- `state.metrics.latency_ms = [120, 140, 160]`
- `state.open_questions = [ ... ]`
- `state.evidence_bundle = [ {doc_id, chunk_id, quote} ]`

### Semantics (normative)
- State updates MUST be deterministic given the same inputs and signals.
- State MAY be serialized for replay.

---

## Triggers
A **trigger** is a deterministic rule: when signals/state match a condition, take an action.

### Action kinds
Two action shapes ship today, both declared inside `on :signal do ... end`:

- **`tool :name, **opts`** — invoke a tool in the gen's `uses` allowlist. Same handler machinery as agentic tool-use; the signal value is passed in as `operands`. Best fit for *bounded, pure-ish computations* (avg, sum, parse, extract) whose return you want written back into the output at `target:`.
- **`action :name, **opts`** *(RED-212)* — invoke a custom action handler registered in the `ActionRegistry`. Actions are side-effect-first (send notification, webhook, update external system) but MAY return `{ value: ... }` to write into `target:`. They do NOT require a `uses` allowlist — they're compile-time declarations, never model-chosen.

### Semantics (normative)
- Triggers MUST be authored by the developer (not the model).
- Trigger conditions SHOULD be based on typed signals/state.
- `tool :name` trigger actions MUST respect the `uses` tool allowlist. An unlisted tool is a runtime error.
- `action :name` triggers MUST resolve their name against the `ActionRegistry` at runner startup; an unknown action MUST fail fast before any Generate step runs.
- Both action kinds run through the same `security`/`budget` env as model-invoked tools: `ctx.fetch` bound to the gen's `NetworkPolicy`, budget `checkBeforeCall` fires before dispatch, permission-denied errors emit `tool.permission.denied` trace events.
- Actions count toward `budget per_run: { max_calls: N }` but NOT `per_tool` (they aren't tools).

---

## Avoiding Regex: Extraction DSL

Regex is powerful but unreadable and fragile. Prefer a higher-level extraction syntax that mirrors how humans talk about the data.

### Example: metric extraction
Desired authoring feel:

```ruby
extract :latency do
  build_query(:number, "ms")
end
```

Interpretation:
- `build_query(:number, "ms")` searches the run transcript/context for number+unit patterns (e.g. "120 ms")
- returns typed matches: `{value: 120, unit: "ms", span: ...}`

### Better: explicit metric primitive
```ruby
extract_metric :latency, unit: "ms"
```

Implementation options:
1) Use an LLM to tag spans (preferred; language flexible)
2) Use a compact parser for number+unit patterns (fast fallback)

Either way, results are typed and stored in state.

---

## Example trigger

```ruby
on metric(:latency) do |m|
  if m.count >= 3
    state.avg_latency_ms = tool(:calculator, expression: "avg(#{m.values})")
  end
end
```

## Custom actions (RED-212)

For side-effect flows — notifications, webhooks, "on completion, update Linear" — declare a trigger with an `action :name` directive. Action handlers live as paired files alongside tool plugins:

```
src/builtin-actions/notify_stderr.action.json   # schema + permissions
src/builtin-actions/notify_stderr.action.ts     # exports execute(input, ctx)
# or app-side at packages/cambium/app/actions/<name>.action.{json,ts}
```

The ActionRegistry auto-discovers these at runner startup and threads them through `evaluateTriggers`. The framework ships `notify_stderr` as a zero-permission reference (writes one line to stderr); custom webhook/Slack actions follow the same handler shape and just add `ctx.fetch` calls + `network_hosts` in their `.action.json`.

```ruby
class IncidentResponder < GenModel
  model :default
  returns IncidentReport
  extract :severity, type: :string, path: "severity"

  on :severity do
    action :notify_stderr, prefix: "[INCIDENT]", message_path: "summary"
    # or: action :webhook, url: "https://hooks.example.com/incidents"
    # or: action :update_linear, team: "RED", title_path: "summary"
  end
end
```

Trace events: `ActionCall` (parallel to `ToolCall`) captures the input, output, and target. Action failures set `ok: false` with an `errors[]` field but do NOT fail the run itself — if you want hard-fail semantics, do that inside the action handler.

---

## See also
- [[P - uses (tools)]]
- [[C - Trace (observability)]]
- [[C - Repair Loop]]
- [[C - IR (Intermediate Representation)]]
