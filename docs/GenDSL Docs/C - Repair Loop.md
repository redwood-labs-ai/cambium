# Runtime: Repair Loop

**Doc ID:** gen-dsl/runtime/repair-loop

## Purpose
Turn "LLM outputs are flaky" into a deterministic operational behavior.

## Default strategy (v0)
- On schema/policy failure, re-ask the model with:
  - the original output
  - the validation errors
  - instruction: "edit invalid fields only"
- On a semantic failure (review, consensus disagreement, corrector feedback, grounding), the same
  three plus the task text and the source document — see § What repair sees, per failure class.
- Cap attempts (default 2).

## What repair sees, per failure class (RED-175)
`handleRepair` takes an optional source bundle — `{ documents, groundingTextByKey, task }` — and only
the sites whose complaint is about *meaning* pass it:

| Site | Complaint | Model that runs it | Source in the request? |
|---|---|---|---|
| `Validate` (`ValidateAfterRepair`), `ValidateConsensusPass`, `enrich` sub-gen | shape (AJV) | `repair` slot if declared | no — context-free by design |
| Review | meaning | gen's model | yes |
| Consensus disagreement | meaning | gen's model | yes |
| Corrector feedback | meaning | gen's model | yes |
| Grounding — citations | meaning | gen's model | yes |
| Grounding — field-values (`verify: :field_values`) | meaning | gen's model | yes |

The structural half is the table's first row and nothing more: same prompt, same model,
byte-identical request as before this section existed.

Semantic sites rebuild the prompt with the **same** `buildGenSystem` / `buildCacheablePrefix` the
Generate step used. Byte-identical system and prefix means the repair request hits the prompt-cache
entry generate already paid for; re-deriving that string moves the cache key and re-bills the whole
document on every attempt — the same trap the fan-out prewarm documents.

### `mode :agentic` — the same assemblers, deliberately not the same variant (#232)

For an agentic gen the cache-riding half of that paragraph does not hold, and no change to the
repair prompt can make it hold. Repair dispatches through `generateText`, which sends **no tools**;
the agentic Generate went through `generateWithTools`. Anthropic builds cache prefixes in the order
`tools` → `system` → `messages`, each level on top of the last — so a tools-less request differs
from that Generate at the *first* level of the hierarchy and cannot read its entry, whatever the
system block and prefix contain. This is the same argument that excludes agentic branches from the
fan-out prewarm (`N - Orchestration Layer` § Fan-out cache prewarm).

Repair therefore builds through `buildGenSystem(ir, schema)` and the default
`includeOutputTemplate` — the **non-agentic** variant — for every gen, agentic ones included.
Passing `{ agentic: true }` here would buy no cache hit and cost two things:

- the system block would tell a request with no tools wired up that it *"has access to tools"*, and
- `includeOutputTemplate: false` would strip the `OUTPUT_JSON_TEMPLATE` block while leaving the
  `REPAIR RULES` line *"Keep every key from OUTPUT_JSON_TEMPLATE"* pointing at nothing.

The single-shot, tools-less variant is the accurate description of the request repair actually
makes. Pinned in `repair-agentic-variant.test.ts`; a repair prompt is byte-identical whether the
gen declares `mode :agentic` or not.

Their prompt also says what the old one could not: correct the quoted text to something that appears
**verbatim** in `DOCUMENT`, and never drop a citation or a grounded value. Before this, a
`Grounding: quote … not found in source` complaint arrived with no source, so the only move that
satisfied it was to delete the citation — a grounded gen that quietly stopped being grounded.

## The deletion guard (RED-175)

Handing repair the document removes the *reason* to delete. The guard catches a deletion anyway,
because "the model behaved" is not a property of this runtime — the operator's contract is.

Both grounding re-verifies now count before and after:

- **Citations** — `citations_before` = quotes the `GroundingCheck` counted on the pre-repair output,
  `citations_after` = the same count on the repaired output. Fewer after ⇒ `deleted_by_repair: true`,
  `GroundingCheckAfterRepair.ok: false`, `finalOk = false`, step loop breaks.
- **Field-values** — same pair as `values_before` / `values_after` on
  `GroundingFieldValueCheckAfterRepair`, same hard fail.

So `ok: true` with `totalChecked: 0` is no longer a report the framework emits: "all citations
verified" and "there were no citations to verify" are now different runs. The run fails as
`validation` (an existing `error.kind`; no twelfth/thirteenth kind needed) and the trace says why in
one field — `jq '.steps[] | select(.meta.deleted_by_repair)'`.

Deliberate edges it does **not** cover, both unchanged from before:

- A run whose output never had citations (`missing`, `totalChecked: 0` on the first `GroundingCheck`)
  is not a deletion — there is no before to lose. `ok: false` on `GroundingCheck`, run still accepted.
- An unhealed but undeleted complaint (a quote still not in the source) stays `ok: false` + accepted,
  matching the corrector rule below: "refuse on unhealed errors" is the caller's job. Deletion is
  different — there the thing the caller asked for is gone, not merely unproven.

## Corrector-feedback repair (RED-275 + RED-298)
- A corrector returning `corrected: false` with `severity: 'error'` issues feeds those issues into a repair attempt.
- After schema revalidation (`ValidateAfterCorrectorRepair`) passes, the runtime **re-runs the same corrector** (`CorrectAfterRepair`) to verify the concern was actually healed — not just that the output is still schema-shaped.
- Each declared corrector has its own `max_attempts` (default 1, ceiling 3). If the corrector's concern persists after `max_attempts` repair iterations, the runtime emits `CorrectAcceptedWithErrors` (terminal `ok: false`) and continues. The output is schema-valid; policy "refuse on unhealed errors" is the caller's job.
- Budget tracking is uniform: every corrector-feedback Repair goes through `pushRepairStep` → `budgetTrack`, so the `per_run` token cap applies across the whole loop.

## `pushRepairStep` — the one way to record a repair (RED-280)

Six repair sites exist in `runGen` — the schema-repair loop, Review, Consensus, corrector feedback, grounding (citations), and grounding field-values (RED-392) — and they used to drift: at RED-280 time three called `trace.steps.push + budgetTrack` while Consensus and grounding silently bare-pushed, leaking the token spend past the budget gate. The `pushRepairStep(repair)` helper at the top of `runGen` encapsulates the pair so a sixth call site can't reintroduce the bug. Any new repair-driven trace step MUST route through `pushRepairStep`; never write `trace.steps.push(repair.result)` in `runner.ts` without also calling `budgetTrack`.

## Post-repair re-verify for grounding paths (RED-398)

Both grounding repair paths (citations and field-values) now **re-verify after repair** before accepting the output. When a repair attempt passes schema revalidation (`ValidateAfterGrounding` / `ValidateAfterGroundingValues`), the relevant corrector runs again immediately:

- **Citations path**: re-runs the `citations` corrector, emits `GroundingCheckAfterRepair`. `ok: false` when fabricated quotes persist after repair (accepted anyway — one repair attempt; the `ok: false` step is greppable via `jq '.steps[] | select(.type == "GroundingCheckAfterRepair" and .ok == false)'`), **and the run fails too** when the repaired output carries fewer citations than the output repair was handed (RED-175, § The deletion guard).
- **Field-values path**: re-runs the `field_values` corrector, emits `GroundingFieldValueCheckAfterRepair`. Same accept-with-trace semantics, plus the same deletion guard on grounded values.

This closes the "schema-valid but unhealed" gap for grounding (the same gap the `CorrectAfterRepair` step closes for regular correctors). See [[C - Trace (observability)]] for the step type rows.

## Repair model slot (RED-176)

Author-facing declaration, allowed kwargs, and common mistakes: [[P - repair (model slot)]]. This section owns the runtime behavior.

`app/config/models.rb` may declare a `repair` slot:

```ruby
default   "omlx:orinth-1.0-35b@q8_0"
fast      "omlx:nvidia/nemotron-3-nano-4b"
embedding "omlx:bge-small-en"
repair    "omlx:nvidia/nemotron-3-nano-4b", max_tokens: 16000, temperature: 0   # floor, not a cap
```

Absent → every repair pass runs on the gen's own model and the IR is byte-identical to pre-RED-176. Declared → the slot is authoritative for the whole workspace. There is **no per-gen `repair:`** escape hatch, matching `memory_policy.rb` (RED-239) and the one-source-per-slot rule (RED-214). Note the asymmetry this leaves: `constrain :compound, model:` is still a per-gen sub-step override — deliberate, recorded here rather than smoothed over.

What the slot carries, and what it refuses:

| Field | Rule |
|---|---|
| `id` | Required, one. Resolved at **compile** time (`ModelAliases`), so `repairModel.id` is always a literal `provider:model` string (RED-237). `repair :fast` is legal and resolves through the aliases above. |
| `max_tokens` | Optional; default `DEFAULT_MAX_TOKENS` (1200), **floored at the gen's ceiling**. Repair re-emits the whole document, so a cap below the gen's turns one recoverable schema failure into a hard `output_ceiling` failure - the exact finding RED-174 recorded. The gen's value wins when it is larger; the slot's only ever raises the cap. |
| `temperature` | Optional; omitted → provider default. |
| `effort` | Refused at parse time (`ModelAliasesBuilder::REPAIR_KWARGS` is a closed list). `effort` is Anthropic-only steering and the repair prompt says “No reasoning”; forwarding the gen's value to a non-Anthropic repair model is a silent no-op, which is its own bug. |
| `fallbacks` | Refused. The gen's RED-421 chain names models chosen for the gen's job; a frontier fallback would send a janitorial pass to the expensive tier. The loop's next attempt is repair's retry. |

**Scope: structural only, on purpose.** The slot is consulted at the two sites whose complaint is about *shape* — the `Validate` loop (`ValidateAfterRepair`) and `ValidateConsensusPass` — plus the `enrich` sub-gen's own validate/repair loop (its IR is a compiled gen IR, so the slot rides on `subIr`). The five semantic sites (Review, consensus disagreement, corrector feedback, grounding citations, grounding field-values) run on the gen's model.

That is not hedging about cost; it is a correctness gate. A semantic complaint is about *meaning* — a quote that isn't verbatim in the source, arithmetic that doesn't check — and repair is now handed the source for exactly those sites (RED-175, see § What repair sees, per failure class). Retrieval-and-verification over a 40-page filing is not a 4B-model job; the janitorial work is. Semantic repair therefore stays on the model the gen declared.

Where this meets the trace: `Repair.meta.model_used` names the model that ran and `Repair.meta.max_tokens` the ceiling in force, so no new step type is needed — the `Repair` row in [[C - Trace (observability)]] covers both. Because of the floor, the number in force is often the gen’s even though a repair model ran, so the operator-facing error names the side that declared it (`gen` or `repair slot`) instead of pointing at a limit the repair slot never set.

## Failure modes
- Cannot repair into a valid instance → hard fail with trace.
- Corrector `max_attempts` exhausted with errors still pending → `CorrectAcceptedWithErrors` step emitted; run continues with schema-valid-but-unhealed output (RED-298).
- Repair hits its own ceiling → `output_ceiling` on the `Repair` step, loop stops, run fails as `output_ceiling` (not `validation`). The step and the error name the repair model / repair slot, not the gen (RED-176 + RED-174).

## See also
- [[P - returns]]
- [[C - Trace (observability)]]
- [[P - corrects (correctors)]]
- [[N - Model Identifiers]] § The `repair` slot
- [[P - repair (model slot)]]
- [[P - grounded_in]] § What repair is given
- [[C - IR (Intermediate Representation)]]
