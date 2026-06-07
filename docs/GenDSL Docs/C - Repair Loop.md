# Runtime: Repair Loop

**Doc ID:** gen-dsl/runtime/repair-loop

## Purpose
Turn "LLM outputs are flaky" into a deterministic operational behavior.

## Default strategy (v0)
- On schema/policy failure, re-ask the model with:
  - the original output
  - the validation errors
  - instruction: "edit invalid fields only"
- Cap attempts (default 2).

## Corrector-feedback repair (RED-275 + RED-298)
- A corrector returning `corrected: false` with `severity: 'error'` issues feeds those issues into a repair attempt.
- After schema revalidation (`ValidateAfterCorrectorRepair`) passes, the runtime **re-runs the same corrector** (`CorrectAfterRepair`) to verify the concern was actually healed — not just that the output is still schema-shaped.
- Each declared corrector has its own `max_attempts` (default 1, ceiling 3). If the corrector's concern persists after `max_attempts` repair iterations, the runtime emits `CorrectAcceptedWithErrors` (terminal `ok: false`) and continues. The output is schema-valid; policy "refuse on unhealed errors" is the caller's job.
- Budget tracking is uniform: every corrector-feedback Repair goes through `pushRepairStep` → `budgetTrack`, so the `per_run` token cap applies across the whole loop.

## `pushRepairStep` — the one way to record a repair (RED-280)

Six repair sites exist in `runGen` — the schema-repair loop, Review, Consensus, corrector feedback, grounding (citations), and grounding field-values (RED-392) — and they used to drift: at RED-280 time three called `trace.steps.push + budgetTrack` while Consensus and grounding silently bare-pushed, leaking the token spend past the budget gate. The `pushRepairStep(repair)` helper at the top of `runGen` encapsulates the pair so a sixth call site can't reintroduce the bug. Any new repair-driven trace step MUST route through `pushRepairStep`; never write `trace.steps.push(repair.result)` in `runner.ts` without also calling `budgetTrack`.

## Post-repair re-verify for grounding paths (RED-398)

Both grounding repair paths (citations and field-values) now **re-verify after repair** before accepting the output. When a repair attempt passes schema revalidation (`ValidateAfterGrounding` / `ValidateAfterGroundingValues`), the relevant corrector runs again immediately:

- **Citations path**: re-runs the `citations` corrector, emits `GroundingCheckAfterRepair`. `ok: false` when fabricated quotes persist after repair (accepted anyway — one repair attempt; the `ok: false` step is greppable via `jq '.steps[] | select(.type == "GroundingCheckAfterRepair" and .ok == false)'`).
- **Field-values path**: re-runs the `field_values` corrector, emits `GroundingFieldValueCheckAfterRepair`. Same accept-with-trace semantics.

This closes the "schema-valid but unhealed" gap for grounding (the same gap the `CorrectAfterRepair` step closes for regular correctors). See [[C - Trace (observability)]] for the step type rows.

## Failure modes
- Cannot repair into a valid instance → hard fail with trace.
- Corrector `max_attempts` exhausted with errors still pending → `CorrectAcceptedWithErrors` step emitted; run continues with schema-valid-but-unhealed output (RED-298).

## See also
- [[P - returns]]
- [[C - Trace (observability)]]
- [[P - corrects (correctors)]]
