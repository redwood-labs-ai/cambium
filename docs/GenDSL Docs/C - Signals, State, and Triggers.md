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

### Actions
- call a tool
- run retrieval
- run a repair loop
- branch to another generate step

### Semantics (normative)
- Triggers MUST be authored by the developer (not the model).
- Trigger conditions SHOULD be based on typed signals/state.
- Trigger actions MUST respect `uses` tool allowlists and security policies.

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

---

## See also
- [[P - uses (tools)]]
- [[C - Trace (observability)]]
- [[C - Repair Loop]]
- [[C - IR (Intermediate Representation)]]
