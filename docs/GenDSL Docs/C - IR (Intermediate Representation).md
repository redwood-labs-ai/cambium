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

## Top-level IR fields

| Field | Source primitive | Notes |
|---|---|---|
| `version`, `entry`, `model`, `system`, `steps` | core | `entry.source` is the primary `.cmb.rb` path |
| `mode` | `mode :agentic` / `mode :retro` | absent = default single-call mode |
| `reads_trace_of` | `reads_trace_of :primary` | retro memory agents only |
| `returnSchemaId` | `returns <Schema>` | validated against contracts.ts at compile (RED-210) |
| `policies.tools_allowed` | `uses :a, :b` | deny-by-default allowlist |
| `policies.correctors` | `corrects :math, :dates` | `Array<{name: string, max_attempts: number}>` — deterministic post-validation transforms. Each entry carries its own `max_attempts` (1..3, default 1, RED-298). Pre-RED-298 IRs with bare-string arrays are normalized to `max_attempts: 1` at run time. |
| `policies.constraints` | `constrain :budget, …` | legacy/ergonomic container for budget, tone, etc. |
| `policies.grounding` | `grounded_in :document` | citation enforcement config |
| `policies.security` | `security network: {...}` or `security :pack` | per-slot mixing; `_packs` metadata for trace (RED-214) |
| `policies.budget` | `budget per_run: {...}` | same per-slot mixing as security |
| `policies.memory[]` | `memory :name, …` (one per decl) | pool-owned slots already merged in at compile (RED-215). Optional per-decl fields on `:semantic` strategy: `query` (literal string anchor) or `arg_field` (pluck a top-level field from JSON `ctx.input`) — RED-238, mutually exclusive. |
| `policies.memory_pools{}` | pool files | only pools actually referenced by this gen are inlined |
| `policies.memory_write_via` | `write_memory_via :Agent` | class name; runner resolves via snake_case lookup |
| `enrichments`, `signals`, `triggers` | `enrich`, `extract`, `on` | sub-agent context + signal → deterministic action |
| `context[<source>]` | runtime `--arg` | the input text passed to the gen method, keyed by the grounding source name (e.g. `"linear_issue"` when the gen declares `grounded_in :linear_issue`); falls back to the `"document"` key when no `grounded_in` is declared. Read via `getGroundingDocument(ir)` in TS code — don't hardcode `ir.context.document` (RED-276). |

## See also
- [[C - Runner (TS runtime)]]
- [[C - Trace (observability)]]
- [[P - generate]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
