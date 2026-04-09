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

## Failure modes
- Cannot repair into a valid instance → hard fail with trace.

## See also
- [[P - returns]]
- [[C - Trace (observability)]]
- [[P - corrects (correctors)]]
