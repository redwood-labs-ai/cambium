# Note: Failure Modes & Debugging

**Doc ID:** gen-dsl/note/failure-modes

## Common failures
- Schema invalid after max repair attempts
- Missing citations with strict grounding
- Tool call blocked by allowlist
- Tool I/O schema mismatch
- Retrieval returns no evidence

## Debug workflow
1) Open the trace
2) Find first failing step
3) Inspect validation errors / policy violations
4) If repair attempted, inspect repair prompt + deltas

## See also
- [[C - Trace (observability)]]
- [[C - Repair Loop]]
