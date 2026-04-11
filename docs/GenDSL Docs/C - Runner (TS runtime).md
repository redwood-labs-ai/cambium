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

## Operational Bulletins (control-plane overlay)
Cambium supports (or will support) a **runtime control-plane overlay** called **Operational Bulletins**.

Bulletins are designed to be:
- fetched by the runner (0 tokens)
- matched deterministically for relevance
- enforced at the tool router / step controller
- delivered at reliable seams (post-tool/post-step), including mid-session

See: `docs/bulletins.md`.

## See also
- [[C - IR (Intermediate Representation)]]
- [[C - Trace (observability)]]
- [[S - Tool Permissions & Sandboxing]]
