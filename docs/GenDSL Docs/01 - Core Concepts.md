# Core Concepts

**Doc ID:** gen-dsl/core-concepts

## The thesis
This DSL is "Rails for generation engineering": reliable LLM programs via conventions, contracts, and auditability.

## Key ideas
- **Programs with contracts:** generation is a transaction with validation + repair.
- **Typed returns:** outputs validate against JSON Schema.
- **Grounding as policy:** citations/provenance are enforced, not requested.
- **Tools as capabilities:** tool calls are declared, permissioned, typed, and logged.
- **IR as truth:** DSL compiles to an auditable JSON plan executed by a runtime.

## See also
- [[C - IR (Intermediate Representation)]]
- [[C - Runner (TS runtime)]]
- [[P - returns]]
- [[P - uses (tools)]]
