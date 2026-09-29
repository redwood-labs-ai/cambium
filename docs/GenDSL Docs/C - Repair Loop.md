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
- **No candidate is not a wrong candidate (#273).** When the Generate output carries no parseable
  JSON at all (`No data to validate`), there is nothing for structural repair to "edit invalid
  fields" in — the repair prompt holds only schema + task + errors, never the tool results or the
  drafted answer, so the model INVENTS values to fill the shape (3 of 88 real agentic runs shipped
  `ok: true` with fabricated tickers; the drafted answer was prose no step ever read). The loop
  re-asks the GEN's own model once — an in-conversation turn for `mode :agentic` (§ Re-ask for
  missing JSON), a context-full semantic re-ask for single mode — re-validates the re-asked
  candidate, and on still nothing fails the run honestly (`validation`, zero `Repair` rows).
  Structural repair now only ever sees an existing-but-invalid candidate.

## Re-ask for missing JSON (#273)

Two dispatch points, one shared directive (`NO_JSON_REASK_DIRECTIVE`: "answer in JSON now, base
every value on the tool results you actually received; do not invent values"):

- **Agentic**: the re-ask is pushed INTO the live conversation — the model's prose becomes an
  assistant turn, the directive a user turn, and the loop `continue`s. Tool transcripts (role
  `tool` messages) stay in history, so the re-ask is grounded in what the tools actually returned.
  One re-ask per run; a still-unparseable answer lands on the `AgenticFinal` row (`ok: false`) and
  the run fails `validation`. A ceiling hit stays terminal (RED-174) — re-ask is skipped, the run
  fails `output_ceiling`. The re-ask **buys a turn of its own** (it raises the loop's turn limit by
  one, once) and never buys a tool call — the tool budget is enforced separately, by `forceFinal`.
  It has to: a run that spends its budget one tool call per turn reaches the forced-final turn on
  the loop's LAST iteration, so a re-ask bounded by the tool budget could not fire in precisely the
  shape most worth rescuing — the model did all the tool work, then wrote it up in prose. When the
  re-ask was spent and the loop then reaches the force-final turn, the "STOP calling tools" text
  MERGES into the trailing directive turn. That merge is a prompt-quality choice, not an API
  constraint (the Anthropic Messages API accepts consecutive same-role messages and folds them into
  one turn): one coherent ask beats two that half-conflict about what to do next.
- **Single / consensus extra-pass / enrich sub-gen**: the validate loop re-asks through
  `handleGenerate` with `extraTail` = the directive. The directive rides the UNCACHED tail — the
  cacheable prefix stays byte-identical to the original Generate, so the re-ask reads the warm
  prompt-cache entry instead of re-billing the document — and the model still sees task + documents
  ahead of the ask. One re-ask per gen (per extra pass / per sub-gen); then fail.

The no-data class is decided **before** stop-on-no-improvement. Both end the run identically, so
the ordering is purely about which row explains it: two prose answers carry identical error counts,
so the improvement check would otherwise win the race and file the run as `RepairStopped`
(`reason: "no_improvement"`) — naming a repair that never ran. Everything that is not the no-data
class falls through to the improvement check unchanged.

Where this meets the trace: a `ReaskForJson` row records each re-ask, and a re-asked candidate
re-validates as `ValidateAfterReask` rather than `ValidateAfterRepair` — these runs have no
`Repair` row for such a name to refer to (see
[[C - Trace (observability)]]); the terminal honest-fail row names the class — `reask_failed`,
`reask_spent_agentic` when the in-loop re-ask already ran, or `reask_not_issued_agentic` when it
never did (a ceiling hit skips it). The outcome is read off the re-ask rows actually in the trace,
so it can never claim a re-ask that nothing backs.

`mode :decision` is exempt: its candidate came from `decide()`, not from a model turn, so there is
nothing to re-ask — the pre-#273 tail (deterministic `Repair` row + `validation` fail) stands, and
`generateText` stays uncalled (DEC-009b pins).


## What repair sees, per failure class (RED-175)
`handleRepair` takes an optional source bundle — `{ documents, groundingTextByKey, task }` — and only
the sites whose complaint is about *meaning* pass it:

| Site | Complaint | Model that runs it | Source in the request? |
|---|---|---|---|
| `Validate` (`ValidateAfterRepair`), `ValidateConsensusPass`, `enrich` sub-gen | shape (AJV) — existing-but-invalid candidate only; *no candidate at all* is the #273 re-ask path (§ Re-ask for missing JSON), not repair | `repair` slot if declared | no — context-free by design |
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

## Corrector-feedback repair (RED-275 + RED-298 + #214 + #266)
- A corrector returning `corrected: false` with `severity: 'error'` issues feeds those issues into a repair attempt.
- After schema revalidation (`ValidateAfterCorrectorRepair`) passes, the runtime re-verifies in declaration order: every corrector declared EARLIER than the one whose repair this was, verification-only (`CorrectReverifyEarlier` per earlier corrector — #214 DEC-001/DEC-003), then **re-runs the same corrector last** (`CorrectAfterRepair`) to verify ITS concern was actually healed — not just that the output is still schema-shaped. Running the triggering corrector last means its verdict refers to bytes the earlier-corrector pass may have already mutated, closing the staleness this reordering exists to fix (DEC-004). The earlier-corrector pass replays the exact ordering the initial pass established — each corrector sees its predecessors' output — rather than inventing a second ordering. Empty for the first-declared corrector (nothing earlier exists): single-corrector gens take this exact path unchanged, byte-identical to pre-#214.
- **The whole declaration-order pass is a bounded fixed point (#266).** #214's replay is per-repair, so it closes "repair rewrote a field behind an earlier corrector's back" but leaves two verdicts taken on bytes that no longer exist: the regressed corrector's own `ok: true`, taken *before* the repair, and — with 3+ correctors — any corrector `j` (`first < j < regressed`) whose verdict predates the regressed corrector's own mutation. So the declaration-order pass itself now repeats whenever any corrector in it mutated the output, up to three passes. Pass 1 is byte-identical to what #214 shipped (`Correct` → `Repair` → `ValidateAfterCorrectorRepair` → `CorrectReverifyEarlier` → `CorrectAfterRepair`); passes 2–3 re-issue those rows with the same shapes, adding `sweep: <n>` to `ValidateAfterCorrectorRepair`/`CorrectAcceptedWithErrors` and a `-sweep<n>` suffix to `CorrectReverifyEarlier` ids so a run's rows stay uniquely addressable. A corrector's own repair loop is still entered only by that corrector, and still at most once per pass — the bounds nest rather than multiply (`passes × that corrector's attempt budget`). Single-corrector gens run exactly one pass (`maxSweeps = 1`): their traces and IR stay byte-identical, which is why no golden snapshot re-mints for this fix.
- **Why this exists (#214):** pre-#214, only the triggering corrector re-ran after its own repair. A repair issued to satisfy corrector B could rewrite fields corrector A had already approved (the repair prompt says "edit ONLY the named fields," which a model — or, deterministically, `--mock` — does not always honor), and nothing checked A again. The motivating case: `ThemePalette`'s `contrast_floor` repair returns schema-valid but unparseable placeholder colors; pre-#214 the run ended `ok: true` with those placeholders shipped as colour values, because `hex_normalize` (declared earlier) was never asked to look again.
- **Budget (#214 DEC-002):** regressions found by the earlier-corrector pass fold into the TRIGGERING corrector's own attempt budget — the driving error set for that corrector's while-loop is the union of its own remaining errors and the earlier correctors' error-severity issues from the latest re-verify pass. No corrector's own repair loop is ever re-entered; only the triggering corrector's `attemptsMade` counter moves. This heals when budget allows (the union shrinking on a later attempt) and degenerates exactly to "report only" when `max_attempts: 1` (today's default) — a corrector re-entering its own loop was rejected outright as O(n²)-attempts with no termination story simpler than the one already in place.
- **Termination:** two nested bounds, both fixed. Inside a pass, the triggering corrector's existing `attemptsMade < maxAttempts` counter (clamped `[1, 3]`) — unchanged from RED-298. Outside it, the fixed point: the declaration-order pass repeats only while some corrector mutated the output, and never more than three times (#266). A pathological pair — an earlier corrector that mutates and keeps re-erroring every pass — therefore still stops: three passes × its own attempt ceiling, then `CorrectSweepExhausted` and the tail continues. No convergence is claimed; the loop is bounded whether the correctors agree or fight.
- Each declared corrector has its own `max_attempts` (default 1, ceiling 3). If the corrector's concern persists after `max_attempts` repair iterations, the runtime emits `CorrectAcceptedWithErrors` (terminal `ok: false`) and continues; an earlier corrector regressed by this loop and still unhealed at exit gets its OWN `CorrectAcceptedWithErrors` row too, carrying `regressed_during` (#214 DEC-005). Because the pass now replays (#266), that corrector is re-asked on every later pass and can emit its own terminal row once per pass — `sweep` on the row says which, and the `regressed_during` row stays attributed to the corrector that caused it. The output is schema-valid; policy "refuse on unhealed errors" is the caller's job.
- Budget tracking is uniform: every corrector-feedback Repair goes through `pushRepairStep` → `budgetTrack`, so the `per_run` token cap applies across the whole loop — including the extra passes #266 adds; the token ceiling is the backstop if three passes of repair are not enough. #266 adds no new repair sites either: the extra rows are replays of `Correct`/`Repair`/`ValidateAfterCorrectorRepair`/`CorrectReverifyEarlier`/`CorrectAfterRepair`, plus one `CorrectSweepExhausted` when the cap (or a throw) ends the fixed point.
- **What this closes (#214 DEC-013 → fixed; audited as AUD-214-001).** The audit's repro — `corrector_a` flags a fingerprint on field `a`, `corrector_b` stamps that fingerprint onto `a` while reporting itself clean, `corrector_c` triggers the repair — used to end with both `CorrectReverifyEarlier` rows `ok: true`, `finalOk: true`, and zero trace rows ever flagging `a`. The pass now replays: `corrector_a` is asked again on passes 2 and 3, so the fingerprint is flagged twice — `Correct` rows with `ok: false` naming `.a`, one per re-check pass — alongside the `regressed_during` row. Same story when the mutation is deterministic rather than repair-driven (`corrector_b` stamps `a` on its first and only turn, no repair anywhere in the trace), which is the half of the class DEC-007-ii deferred and DEC-013 refused to split. The regressed field still ships — accepted-with-flag, not halted — but "the field was never checked again" is no longer true, and `jq '.steps[] | select(.ok == false)'` now returns rows to refuse on.
- **Out of scope (next ticket candidates):** staleness at the *other* semantic repair sites — grounding citation / field-value re-verify, review, consensus — which mutate `parsed` after this block entirely and carry their own RED-398/RED-175 fail-closed machinery (`GroundingCheckAfterRepair`, `GroundingFieldValueCheckAfterRepair`, `Review`, `ConsensusMerge`). Those verify provenance and consensus, not corrector verdicts. Also open: making the cap configurable (`sweeps:` on the `corrects` declaration) — deliberately not added, since a workspace that needs a different number can edit the one `maxSweeps` constant in `packages/cambium-runner/src/runner.ts` and re-bundle.

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
- No JSON at all → one semantic re-ask (§ Re-ask for missing JSON), then honest `validation` fail with zero `Repair` rows and a terminal `ReaskForJson` row naming the class (#273). No fabricated candidate can reach the caller — the pre-#273 behavior was `ok: true` with values the model invented from the schema alone.

## See also
- [[P - returns]]
- [[C - Trace (observability)]]
- [[P - corrects (correctors)]]
- [[N - Model Identifiers]] § The `repair` slot
- [[P - repair (model slot)]]
- [[P - grounded_in]] § What repair is given
- [[C - IR (Intermediate Representation)]]
