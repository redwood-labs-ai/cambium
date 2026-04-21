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

## Failure modes
- Cannot repair into a valid instance → hard fail with trace.
- Corrector `max_attempts` exhausted with errors still pending → `CorrectAcceptedWithErrors` step emitted; run continues with schema-valid-but-unhealed output (RED-298).

## See also
- [[P - returns]]
- [[C - Trace (observability)]]
- [[P - corrects (correctors)]]
