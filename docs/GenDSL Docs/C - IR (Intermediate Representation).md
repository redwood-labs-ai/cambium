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

## IR kinds

Two IR shapes ship today, distinguished by the top-level `kind` field:

- **Gen IRs** (no `kind` field, or `kind` absent — back-compat default): the shape compiled from `.cmb.rb` `GenModel` subclasses. The table below describes this shape. Most fields are gen-specific.
- **Pipeline IRs** (`kind: "Pipeline"`, RED-381): the shape compiled from `.pipeline.rb` `Cambium::Pipeline` subclasses. Carries `input`, `policies`, `operators[]`, and `output` — different top-level shape from gens. See "Pipeline IR fields" below.

The CLI and `cambium serve` dispatch by `ir.kind`: pipeline IRs route through `runPipelineFromIr`, gens through `runGenFromIr`.

## Top-level IR fields (gen IRs)

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
| `policies.grounding` | `grounded_in :document` | citation enforcement config: `{ source, require_citations, from?, verify? }`. `verify` (optional string, RED-392) names the value-level verification strategy run after generation — `"field_values"` is the only supported value in v1; cross-checks each output field value against the grounding document. |
| `policies.security` | `security network: {...}` or `security :pack` | per-slot mixing; `_packs` metadata for trace (RED-214) |
| `policies.budget` | `budget per_run: {...}` | same per-slot mixing as security |
| `policies.memory[]` | `memory :name, …` (one per decl) | pool-owned slots already merged in at compile (RED-215). Optional per-decl fields on `:semantic` strategy: `query` (literal string anchor) or `arg_field` (pluck a top-level field from JSON `ctx.input`) — RED-238, mutually exclusive. |
| `policies.memory_pools{}` | pool files | only pools actually referenced by this gen are inlined |
| `policies.memory_write_via` | `write_memory_via :Agent` | class name; runner resolves via snake_case lookup |
| `enrichments`, `signals`, `triggers` | `enrich`, `extract`, `on` | sub-agent context + signal → deterministic action |
| `context[<source>]` | runtime `--arg` | input for the gen, keyed by name. Values are **either** plain strings (text passed to the gen method, keyed by the grounding source when `grounded_in :<name>` is declared — RED-276; read via `getGroundingDocument(ir, groundingTextByKey)`, don't hardcode `ir.context.document`) **or** typed document envelopes `{ kind: 'base64_pdf' \| 'base64_image', data: string, media_type: string }` (RED-323; extracted via `extractDocuments(ir)` in `documents.ts` and emitted as Anthropic content blocks). For `base64_pdf` envelopes the runner also extracts plain text via `pdfjs-dist` and populates `groundingTextByKey[<source>]` so `grounded_in :<same_key>` verifies citations against the PDF content (0.3.1 fix). Non-Anthropic providers fail fast when envelopes are present. See `N - Model Identifiers` § Native document input for size caps + wire shape. |

## Pipeline IR fields (RED-381)

A Pipeline IR has `kind: "Pipeline"` and a structurally distinct top-level shape from gens — no `steps`, no `returnSchemaId`, no `enrichments`/`signals`/`triggers`. The runner dispatches operators in declaration order; sub-gen IRs are compiled on demand at each step's dispatch.

| Field | Source primitive | Notes |
|---|---|---|
| `kind` | (discriminant) | `"Pipeline"` literal — `ir.kind === "Pipeline"` routes to `runPipelineFromIr` |
| `version`, `name`, `entry` | core | `entry.source` is the `.pipeline.rb` path; `name` mirrors `entry.class` for trace observability |
| `input` | `input :name, schema: X` | `Record<string, { schema: string }>` — declared input slots. Schemas validated against `src/contracts.ts` at compile time. Single-slot pipelines accept the CLI `--arg` value as that slot; multi-slot expect a JSON object. |
| `policies.budget` | `budget tokens: N, tool_calls: N` | `{ tokens?: number, tool_calls?: number }` — pipeline-level cap (ceiling, not quota). Pre-dispatch token check via projection from each sub-gen's `model.max_tokens`; post-step tool-call check. |
| `policies.security` | `security :pack_name` or `security network: {...}` | inherited into every sub-gen by default; sub-gen `security` blocks override per-slot. Same per-slot mixing rule as gen-side (RED-214). |
| `policies.bind_defaults` | `bind_defaults :explicit | :pass_through` | `:explicit` (shipped default) or `:pass_through` (prior step's output flows into next step's primary input slot). |
| `policies.memory[]` | `memory :name, strategy: :sym, ...` | pipeline-level memory slots (pipeline-authoritative on strategy/embed/keyed_by/retain). Sub-gens opt in via `memory :name, scope: :pipeline_run`. Bucket keyed by the pipeline's run id; all sub-gens of one run share the bucket. |
| `policies.schedules[]` | `cron :daily, at: "9:00"` | same shape as gen `policies.schedules[]`; `cambium schedule list/compile` recognizes `.pipeline.rb` alongside `.cmb.rb` (RED-381 Phase F.1). |
| `policies.log[]` | `log :datadog, ...` | same shape as gen `policies.log[]`. Run-level events use `<snake_pipeline_name>.<method>.<event>` (`complete` / `failed`). |
| `operators[]` | `step`, `fan_out`, `branch_on` | typed entries: `{ kind: "Step", id, gen, method, with[] }`, `{ kind: "FanOut", id, branches[], concurrency?, on_branch_failure, require, pass_context?, collect_into, _homogeneous? }`, `{ kind: "BranchOn", signal, branches[], default? }`. `with[]` and `signal` carry `bind()` refs cross-validated against input + step outputs at compile time. |
| `output` | `output do ... end` | optional. `{ kind: "last_step" }` (default) means pipeline output = last step's output. `{ kind: "compose", fields: [{ name, from }] }` means assembled from named bind refs. |
| `context` | runtime `--arg` | `{ "_pipeline_arg": <string> }` — the raw CLI arg. `parsePipelineInputs()` in the runtime maps this to input slots (single slot gets the raw string; multi-slot expects JSON-object). |

The bind-ref shape inside `with[]`, `signal`, and `output.fields[]` is `{ from: { input: <slot_name> | true } | { step: <step_id>, field?: <dotted_path> } | { literal: <value> } }`. Compile-time validation walks every ref and rejects:

- unknown input slot names (typo'd `bind(:input).foo`)
- step ids that don't appear earlier in the operator list (forward refs)
- non-bind values where a bind is required (e.g. `branch_on` signals must be `bind(:step).field`)

## See also
- [[C - Runner (TS runtime)]]
- [[C - Trace (observability)]]
- [[P - generate]]
- [[P - Memory]]
- [[P - Policy Packs (RED-214)]]
- [[N - Orchestration Layer]] — Pipeline IR design + operator semantics
