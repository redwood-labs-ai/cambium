# Primitive: uses (tools)

**Doc ID:** gen-dsl/primitive/uses

## Purpose
Declare tool capabilities available to a GenModel/generate transaction.

## Semantics (normative)
- Tools are **denied by default** (recommended).
- A run MUST NOT call undeclared tools.
- Every tool call MUST be logged in the trace with typed input/output.

## Example
```ruby
uses :vector_search, :calculator
```

## Failure modes
- Attempted call to undeclared tool.
- Tool input/output fails schema validation.

## See also
- [[D - Tools Registry]]
- [[S - Tool Permissions & Sandboxing]]
- [[C - Trace (observability)]]
