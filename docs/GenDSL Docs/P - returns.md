# Primitive: returns

**Doc ID:** gen-dsl/primitive/returns

## Purpose
Declare the output contract: the result must validate against a schema.

## Semantics (normative)
- If `returns <Schema>` is set, the runtime MUST validate the generated output against that schema.
- Validation errors MUST be surfaced in trace.
- The repair loop MUST only change fields implicated by validation errors (default strategy).

## Examples
```ruby
returns AnalysisReport
```

## Failure modes
- **Schema not found at compile time** (RED-210). The Ruby compiler validates `returns <Name>` against the package's `contracts.ts` and fails with a list of available schemas + a "did you mean" suggestion. This catches typos before the runner even starts.
- **Schema not found at runtime.** The runner validates the resolved schema id against its in-memory AJV registry as a final safety net.
- **Output cannot be repaired into a valid instance.** The repair loop surrenders after `max_attempts` or when no error-count improvement is seen between attempts. See [[C - Repair Loop]].

## See also
- [[D - Schemas (JSON Schema)]]
- [[C - Repair Loop]]
- [[C - Trace (observability)]]
