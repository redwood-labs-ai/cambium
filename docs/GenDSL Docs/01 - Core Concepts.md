# Core Concepts

**Doc ID:** gen-dsl/core-concepts

## The thesis
This DSL is "Rails for generation engineering": reliable LLM programs via conventions, contracts, and auditability.

## Key ideas
- **Programs with contracts:** generation is a transaction with validation + repair.
- **Typed returns:** outputs validate against JSON Schema; `returns <Name>` is compile-time checked against your contracts module (RED-210).
- **Grounding as policy:** citations/provenance are enforced, not requested.
- **Tools as capabilities:** tool calls are declared, permissioned, typed, and logged. Handlers live next to their schemas in `app/tools/` and are auto-discovered (RED-209).
- **Sandboxing as declaration:** `security network: { allowlist: [...] }` and `budget per_tool: {...}` are first-class primitives. SSRF guard + IP pinning + per-tool call caps are enforced at the dispatch site, not hand-plumbed in each tool (RED-137).
- **Reusable policy:** security and budget can be bundled into named policy packs (`security :research_defaults`) so a gen reads as a declaration of intent, not a tuning panel (RED-214).
- **IR as truth:** DSL compiles to an auditable JSON plan executed by a single canonical runtime.

## See also
- [[C - IR (Intermediate Representation)]]
- [[C - Runner (TS runtime)]]
- [[P - returns]]
- [[P - uses (tools)]]
- [[P - Policy Packs (RED-214)]]
- [[S - Tool Sandboxing (RED-137)]]
