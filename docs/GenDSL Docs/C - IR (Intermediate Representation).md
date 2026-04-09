# Compilation: IR (Intermediate Representation)

**Doc ID:** gen-dsl/compiler/ir

## Purpose
Define the auditable, replayable plan that the DSL compiles to.

## Semantics (normative)
- IR is the source of truth for execution.
- IR MUST be serializable (JSON) and versioned.
- IR SHOULD be compatible across runtimes and model providers.

## Step types (v0 sketch)
- Retrieve
- Generate
- ToolCall
- Validate
- Repair
- Return

## See also
- [[C - Runner (TS runtime)]]
- [[C - Trace (observability)]]
- [[P - generate]]
