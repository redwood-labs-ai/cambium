# Runtime: Runner (TS runtime)

**Doc ID:** gen-dsl/runtime/runner

## Purpose
Execute IR steps with policy enforcement, validation, and full tracing.

## Responsibilities
- Load app config + registries (schemas, tools, grounding sources)
- Execute IR graph
- Enforce:
  - tool allowlist
  - grounding/citation policy
  - schema validation
  - repair strategy
- Emit trace

## See also
- [[C - IR (Intermediate Representation)]]
- [[C - Trace (observability)]]
- [[S - Tool Permissions & Sandboxing]]
