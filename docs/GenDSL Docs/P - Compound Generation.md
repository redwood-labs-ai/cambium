# Primitive: Compound Generation

**Doc ID:** gen-dsl/primitive/compound-generation

## Purpose
Use redundancy to catch model errors — dropped data, unfaithful extraction, inconsistent outputs. Declared as constraints, like ORM options: simple declarations that change runtime behavior without changing the DSL.

## The problem
LLMs are lossy. A model asked to extract 4 data points may output 2. Post-hoc correctors can't reliably fix this without reimplementing the extraction (wrong layer). Compound generation uses the model itself as the check, through redundancy.

## Two strategies

### `:compound, strategy: :review`
After validation passes, a second LLM call reviews the output against the source document. The review is targeted: "Does this output faithfully capture all data from the document? List omissions." If the review finds issues, those become repair instructions fed back through the existing repair loop.

**Cost:** +1 LLM call per generate step.

**Pipeline:** Generate → Validate → **Review** → (Repair if review found issues) → Correct → Triggers

**Best for:** Data extraction tasks where faithfulness to the source matters.

```ruby
constrain :compound, strategy: :review
```

#### Per-gen review knobs (RED-325, 0.3.2)

Three optional kwargs let an author tune the review independently of the main gen:

```ruby
constrain :compound, strategy: :review,
  max_tokens: 2000,                              # default 2000 (raised from 300 in 0.3.2)
  temperature: 0.0,                              # default 0.1 — colder reviews catch more
  model: "anthropic:claude-haiku-4-5-20251001"   # default inherits ir.model.id
```

The `model` knob is the high-leverage one — run the main gen on Sonnet 4.6 and the reviewer on Haiku to cut review cost ~3-4x without quality loss for "is this output internally consistent" checks.

Unknown kwargs raise a clear compile-time error so typos (`max_token: 2000`) don't silently fall through to defaults.

**Resilience (RED-325 Part 2):** review is advisory — provider failures (HTTP errors, timeouts, malformed responses) do NOT crash the host gen. The trace shows `Review` step with `ok: false, meta.skipped_reason: 'provider_error'`; the gen continues to render and commit. Downstream code branching on `review.ok` keeps working.

### `:consistency, passes: N`
Generate N times independently. Compare outputs field-by-field. Where all N agree, high confidence. Where they disagree, the disagreement becomes a targeted repair instruction. For arrays, the longest array wins (more data = better).

**Cost:** +(N-1) LLM calls per generate step.

**Pipeline:** Generate×N → **Consensus** → (Repair if disagreements) → Validate → Correct → Triggers

**Best for:** High-stakes inference where correctness matters more than latency.

```ruby
constrain :consistency, passes: 2
```

## Semantics (normative)
- Compound constraints MUST be opt-in per GenModel (not global).
- Review and consistency MAY be combined on the same GenModel.
- Compound steps MUST be captured in the trace with full detail.
- Review is advisory: if the review LLM call fails to parse, the original output is kept (fail open).
- Consistency takes the longest array when lengths disagree (prefer completeness).

## Composability
These constraints compose with everything else:
- **With repair:** Review/consensus issues feed into the existing repair loop.
- **With correctors:** Correctors run after compound checks resolve.
- **With signals/triggers:** Triggers fire on the final (possibly compound-corrected) output.

## Trace output

### Review trace entry
```json
{
  "type": "Review",
  "ok": false,
  "ms": 5200,
  "meta": {
    "issues": [
      { "path": "metrics.latency_ms_samples", "message": "Document has 4 latency values but output only includes 2" }
    ]
  }
}
```

### Consensus trace entry
```json
{
  "type": "Consensus",
  "ok": false,
  "meta": {
    "passes": 2,
    "disagreements": [
      { "path": "metrics.latency_ms_samples", "values": [[120, 195], [120, 140, 160, 195]], "message": "Array lengths differ across passes: [2, 4]" }
    ]
  }
}
```

## The ORM analogy
Think of these like Sequelize's `paranoid: true` — a simple option that fundamentally changes what `destroy()` does under the hood. Here, `constrain :compound, strategy: :review` fundamentally changes what `generate` does, without the author needing to think about the mechanics.

## See also
- [[P - constrain]]
- [[C - Repair Loop]]
- [[C - Trace (observability)]]
- [[P - generate]]
