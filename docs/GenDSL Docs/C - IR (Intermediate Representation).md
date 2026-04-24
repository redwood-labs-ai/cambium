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
| `policies.log` | `log :datadog, include: [:signals]` | `Array<{destination, include, granularity, endpoint?, api_key_env?, _profile?}>` — trace-fan-out destinations (RED-282 / RED-302). Profile references are resolved at compile time and inlined; `_profile` preserves the source name for trace observability. |
| `policies.log_profiles` | (derived) | `Array<string>` — profile names referenced by any `log :name` call. Metadata-only; runner doesn't branch on it. |
| `policies.schedules` | `cron :daily, at: "9:00"` | `Array<{id, expression, method, tz, named?, at?}>` — scheduled-fire declarations (RED-273 / RED-305). Method defaults are resolved at compile time. IDs are stable `<snake_gen>.<method>.<slug>` shape and match `--fired-by schedule:<id>` at runtime. |
| `policies.constraints` | `constrain :budget, …` | legacy/ergonomic container for budget, tone, etc. |
| `policies.grounding` | `grounded_in :document` | citation enforcement config |
| `policies.security` | `security network: {...}` or `security :pack` | per-slot mixing; `_packs` metadata for trace (RED-214) |
| `policies.budget` | `budget per_run: {...}` | same per-slot mixing as security |
| `policies.memory[]` | `memory :name, …` (one per decl) | pool-owned slots already merged in at compile (RED-215). Optional per-decl fields on `:semantic` strategy: `query` (literal string anchor) or `arg_field` (pluck a top-level field from JSON `ctx.input`) — RED-238, mutually exclusive. |
| `policies.memory_pools{}` | pool files | only pools actually referenced by this gen are inlined |
| `policies.memory_write_via` | `write_memory_via :Agent` | class name; runner resolves via snake_case lookup |
| `enrichments`, `signals`, `triggers` | `enrich`, `extract`, `on` | sub-agent context + signal → deterministic action |
| `context[<source>]` | runtime `--arg` | input for the gen, keyed by name. Values are **either** plain strings (text passed to the gen method, keyed by the grounding source when `grounded_in :<name>` is declared — RED-276; read via `getGroundingDocument(ir)`, don't hardcode `ir.context.document`) **or** typed document envelopes `{ kind: 'base64_pdf' \| 'base64_image', data: string, media_type: string }` (RED-323; extracted via `extractDocuments(ir)` in `documents.ts` and emitted as Anthropic content blocks). Non-Anthropic providers fail fast when envelopes are present. See `N - Model Identifiers` § Native document input for size caps + wire shape. |

## See also
- [[C - Runner (TS runtime)]]
- [[C - Trace (observability)]]
- [[P - generate]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
