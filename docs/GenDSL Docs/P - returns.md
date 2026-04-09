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
- Schema not found.
- Output cannot be repaired into a valid instance.

## See also
- [[D - Schemas (JSON Schema)]]
- [[C - Repair Loop]]
- [[C - Trace (observability)]]
