# Primitive: repair (model slot)

**Doc ID:** gen-dsl/primitive/repair-model-slot

## Purpose

Name, once per workspace, the cheaper model that runs repair passes instead of each gen's frontier model (RED-176). This is *not* a gen declaration — it lives in `app/config/models.rb` beside the aliases, and there is no per-gen `repair:`.

Runtime behavior: [[C - Repair Loop]] § Repair model slot · Resolution rules: [[N - Model Identifiers]] § The `repair` slot

## Forms

```ruby
# app/config/models.rb
default  "omlx:Qwen3.5-27B-4bit"
fast     "omlx:gemma-4-31b-it-8bit"

repair   "omlx:nvidia/nemotron-3-nano-4b", max_tokens: 16000, temperature: 0
# or reference an alias declared above:
# repair :fast
```

## Semantics (normative)

- One slot per scope. A second `repair` at the same scope (global, or inside the same `profile` block) is a `CompileError`. `model :repair` is also a `CompileError` — it is a slot, not an alias, and gens cannot reference it.
- Allowed kwargs: `max_tokens` (positive Integer) and `temperature` (Numeric). Anything else — including `effort:` and `fallbacks:` — fails at parse time (`ModelAliasesBuilder::REPAIR_KWARGS` is a closed list). Silent inheritance from the gen is what this refusal prevents.
- Inside a `profile :name do … end` block, `repair` shadows the global slot when that profile is active (via `--profile` or `CAMBIUM_PROFILE`); declared only in an inactive profile, it is invisible and the global wins.
- The id resolves at compile time (RED-237) and ships to the IR as top-level `repairModel` — see the `repairModel` row in [[C - IR (Intermediate Representation)]]. No `repair` declared → key omitted → IR byte-identical to pre-RED-176 and repair runs on the gen's model.
- Floor rule: repair never gets less output room than generate had — `max_tokens` is a floor request, not a cap on the gen's own calls. Details and worked example: [[C - Repair Loop]] § Repair model slot.
- Structural repair only: the schema-Validate loop (`ValidateAfterRepair`), `ValidateConsensusPass`, and the `enrich` sub-gen's own validate/repair loop (the slot rides on the sub-IR). Semantic sites — Review, consensus disagreement, corrector feedback, grounding citations, grounding field-values — run on the gen's model (RED-175): their complaint is about meaning, repair is handed the source document, and retrieval-and-verification over a real filing is not a 4B-model job. Why: [[C - Repair Loop]] § What repair sees, per failure class.
- Attempt counts are untouched: `corrects … max_attempts:` and `policies.max_repair_attempts` still decide how many repair passes run. The slot only decides who runs them.

## Trace + cost

No new trace step types: the existing `Repair` step records the swap — `meta.model_used` names the model that ran, `meta.max_tokens` the ceiling in force, `meta.source_chars` / `meta.source_docs` / `meta.source_doc_bytes` what the pass was handed (RED-175; all three `0` on structural passes) ([[C - Trace (observability)]]). Spend still routes through `pushRepairStep` (RED-280), so budget tracking holds even when repair is cheap. Because semantic repair now carries the document, these are the numbers to watch when a repair loop's cost looks wrong — `source_chars` on the extracted-text path, `source_doc_bytes` when the document reaches the model as a native envelope.

## Typical setup

```ruby
# app/config/models.rb
default  "anthropic:claude-opus-4-6"                       # judgment: generate, review, semantic repair
repair   "omlx:nvidia/nemotron-3-nano-4b", max_tokens: 16000  # one-shot JSON reshaping
```

## Common mistakes

- Declaring `repair` in a `.cmb.rb`. It is a workspace slot; gen files never mention it. (Spec-draft-era examples showing `repair max_attempts: 3` inside a gen describe a declaration that never shipped — `max_attempts` hangs on `corrects`. See [[P - corrects (correctors)]].)
- `model :repair` — compile error; reference `:default` / `:fast` instead.
- Pinning `repair` to a model that can't reliably emit schema-valid JSON: the structural loop burns its attempts and the run hard-fails with `ok: false` on the last `ValidateAfterRepair` step. Re-pin the slot; do not delete the gen's `returns` block.

## See also

- [[C - Repair Loop]] — the loop itself: sites, floor math, re-verify, terminals (authoritative)
- [[N - Model Identifiers]] § The `repair` slot — alias resolution + profile shadowing
- [[C - IR (Intermediate Representation)]] — `repairModel` row
- [[P - Golden Tests (RED-140)]] — declared slot changes golden IR snapshots (`repairModel` appears in `tests/golden/ir/gens/*.json`)
