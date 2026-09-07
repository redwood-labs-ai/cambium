# Compilation: IR (Intermediate Representation)

**Doc ID:** gen-dsl/compiler/ir

## Purpose
Define the auditable, replayable plan that the DSL compiles to.

## Semantics (normative)
- IR is the source of truth for execution.
- IR MUST be serializable (JSON) and versioned.
- IR SHOULD be compatible across runtimes and model providers.

## Two-level contract: promised JSON shape vs. unpromised TypeScript type

The IR has two distinct contractual surfaces:

**Promised: the JSON shape.** The fields documented in the tables below are the golden-pinned data contract — byte-identical IR JSON is what `npm run test:golden` protects. Adding an IR field is additive (same philosophy as `schema.rb`). The JSON shape is what the roadmap means when it says "IR is the promised data contract."

**Unpromised: the exported TypeScript type.** `export type IR` in `@redwood-labs/cambium-runner` is an **opaque, phantom-branded handle** (Road to 1.0, Gate 1). Consumers obtain `IR` values via `cambium compile`, by passing a `JSON.parse(irText)` result (typed `any`) to runner functions, or from runner result objects (`RunGenResult.ir`). They do not read fields off the exported type — field access on `IR` is a TypeScript compile error. This is intentional: it keeps the internal shape free to evolve without breaking consumer code. This distinction is formalized in [`COMPATIBILITY.md`](../../COMPATIBILITY.md) § IR JSON shape (and the opaque TypeScript type) — the repo-root 1.0 compatibility promise.

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
| `version`, `entry`, `model`, `system`, `steps` | core | `entry.source` is the primary `.cmb.rb` path. `model.id` is the primary provider-prefixed model id (alias-resolved at compile, RED-237). |
| `model.fallbacks` | `model "primary", "fallback1", …` (varargs, RED-421) | `string[] \| undefined` — ordered fallback model ids, each alias-resolved at compile time. Absent (key omitted) when only one model is declared, so single-`model` IRs are byte-identical to pre-RED-421. On a transient failure of the primary the runner walks this list in order (see `N - Model Identifiers` § Multi-provider fallback). |
| `mode` | `mode :agentic` / `mode :retro` | absent = default single-call mode |
| `repairModel` | `app/config/models.rb`: `repair "omlx:nemotron-3-nano-4b", max_tokens: 900` (RED-176) | `{ id, max_tokens?, temperature? } \| undefined` — the model that runs repair passes instead of the gen's; `max_tokens` is floored at the gen's ceiling, so repair never gets less room than generate had. Set by exactly one source (the workspace; there is no per-gen `repair:`), resolved at compile time like every other alias, so the runner never sees a Symbol (RED-237). Key omitted when no `repair` slot is declared → IR byte-identical to pre-RED-176. Consumed by the structural repair sites only; see [[C - Repair Loop]] § Repair model slot for the structural/semantic split and the four-field decision, and [[P - repair (model slot)]] for how authors declare it. |
| `effort` | `effort "high"` | `string` (only from DSL via compile-time validation; runner accepts `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"`). Sent as `body.output_config.effort` + `body.thinking: { type: "adaptive" }` to Anthropic models that dropped sampling params (Opus 4.7+, Fable 5, Mythos 5); `max_tokens` is sent unchanged on every model (see `N - Model Identifiers`). Emitted as `null` (present, not omitted — same as `mode`) when the gen didn't declare effort. |
| `reads_trace_of` | `reads_trace_of :primary` | retro memory agents only |
| `excludeFromPrefix` | `exclude_from_prefix :page_id` (#182) | `string[] \| undefined` — context keys that reach the model but must NOT contribute to `cacheablePrefix` byte-identity. The runner renders them into the *uncached tail* of the user prompt instead (see [[P - GenModel]] § `exclude_from_prefix`), so a `fan_out` whose branches differ only in these keys collapses to ONE prewarm group instead of one per branch. Honoured **only when the cached-prefix path is active** — below the cache floor, or on a provider with no `supportsPromptCacheControl`, the field is inert and the prompt is byte-identical to a gen that never declared it. Absent (key omitted, not `[]`, not `null`) when the gen declares none, so every pre-#182 gen compiles byte-identically — same rule as `effort` and `model.fallbacks`. Naming the `grounded_in` source or a `_`-prefixed key is a compile error, so neither can appear here from a compiled gen; a hand-built IR that carries one anyway is a no-op (the document stays in the prefix, `_` keys stay hidden). |
| `returnSchemaId` | `returns <Schema>` (name form) | string name-ref; validated against contracts.ts at compile (RED-210). Mutually exclusive with `returnSchema`. |
| `returnSchema` | `returns do … end` (block form, RED-419) | inline Draft-07 JSON Schema object, additive. Carries its own `$id: "<ClassName>Output"`, `additionalProperties: false` at every object level, computed `required`. The runtime resolves `ir.returnSchema ?? contractsMod[ir.returnSchemaId]` — inline wins. Self-contained: a block-form gen runs and validates with no `contracts.ts` and no generated file. Closed vocabulary (see [[P - returns]]). |
| `policies.tools_allowed` | `uses :a, :b` | deny-by-default allowlist |
| `policies.correctors` | `corrects :math, :dates` | `Array<{name: string, max_attempts: number}>` — deterministic post-validation transforms. Each entry carries its own `max_attempts` (1..3, default 1, RED-298). Pre-RED-298 IRs with bare-string arrays are normalized to `max_attempts: 1` at run time. |
| `policies.log` | `log :datadog, include: [:signals]` | `Array<{destination, include, granularity, endpoint?, api_key_env?, _profile?}>` — trace-fan-out destinations (RED-282 / RED-302). Profile references are resolved at compile time and inlined; `_profile` preserves the source name for trace observability. |
| `policies.log_profiles` | (derived) | `Array<string>` — profile names referenced by any `log :name` call. Metadata-only; runner doesn't branch on it. |
| `policies.schedules` | `cron :daily, at: "9:00"` | `Array<{id, expression, method, tz, named?, at?}>` — scheduled-fire declarations (RED-273 / RED-305). Method defaults are resolved at compile time. IDs are stable `<snake_gen>.<method>.<slug>` shape and match `--fired-by schedule:<id>` at runtime. |
| `policies.constraints` | `constrain :budget, …` | legacy/ergonomic container for budget, tone, etc. |
| `policies.grounding` | `grounded_in :document` | citation enforcement config: `{ source, require_citations, from?, verify?, fields?, format? }`. `verify` (optional string, RED-392) names the value-level verification strategy run after generation — `"field_values"` is the only supported value in v1; cross-checks each output field value against the grounding document. `format` (optional string, #169) names the shape of a text source — `"markdown" \| "json" \| "text"` — so the verifier matches against a derived plain-text view of it in addition to the raw text; it is set explicitly or inferred at compile time from the extension of whichever path supplied the context value (`--arg` over `from:`), and **absent when unset**, so a gen that doesn't use it compiles byte-identically. |
| `policies.security` | `security network: {...}` or `security :pack` | per-slot mixing; `_packs` metadata for trace (RED-214). Per-slot field shapes are owned by their subsystem docs, not enumerated here — the `exec` slot shape (`allowed`/`runtime`/`unsafe_native`/`cpu`/`memory`/`timeout`/`network`/`filesystem`/`max_output_bytes`; Gate 3 strict-default) lives in [[S - Tool Exec Sandboxing (RED-213)]]. |
| `policies.budget` | `budget per_run: {...}` | same per-slot mixing as security |
| `policies.memory[]` | `memory :name, …` (one per decl) | pool-owned slots already merged in at compile (RED-215). Optional per-decl fields on `:semantic` strategy: `query` (literal string anchor) or `arg_field` (pluck a top-level field from JSON `ctx.input`) — RED-238, mutually exclusive. |
| `policies.memory_pools{}` | pool files | only pools actually referenced by this gen are inlined |
| `policies.memory_write_via` | `writes_memory_via :Agent` | class name; runner resolves via snake_case lookup |
| `enrichments`, `signals`, `triggers` | `enrich`, `extract`, `on` | sub-agent context + signal → deterministic action |
| `context[<source>]` | runtime `--arg` | input for the gen, keyed by name. Values are **either** plain strings (text passed to the gen method, keyed by the grounding source when `grounded_in :<name>` is declared — RED-276; read via `getGroundingDocument(ir, groundingTextByKey)`, don't hardcode `ir.context.document`) **or** typed document envelopes `{ kind: 'base64_pdf' \| 'base64_image', data: string, media_type: string }` (RED-323; extracted via `extractDocuments(ir)` in `documents.ts` and emitted as Anthropic content blocks). For `base64_pdf` envelopes the runner also extracts plain text via `pdfjs-dist` and populates `groundingTextByKey[<source>]` so `grounded_in :<same_key>` verifies citations against the PDF content (0.3.1 fix). Non-Anthropic providers fail fast when envelopes are present. See `N - Model Identifiers` § Native document input for size caps + wire shape. |

**`entry.source` portability (#195).** `entry.source` is the raw argv path the Ruby compiler was given — absolute when compiled via `cambium compile --out-dir`/compile-all, relative when compiled via `cambium compile <rel-path>` (ground fact, not derived: `compile.rb` never expands it). It is a fine default anchor when the IR is compiled and run on the same machine in the same process invocation, but it is **never load-bearing** for a precompiled artifact run in place: `cambium serve --precompiled`/`--ir-dir` and `cambium run --ir` both anchor tool/action/provider/log-sink/contracts/corrector discovery on the artifact's own on-disk location (`opts.appRoot` / `opts.engineDir`, explicit-wins per [[N - App Mode vs Engine Mode (RED-220)]] item 4), not on this field. Don't add a load-bearing read of `entry.source` to a precompiled-artifact code path — it may point at a build machine that no longer exists, or at a *relative* path that resolves into an unrelated workspace if naively joined against the running process's cwd. See [[N - Precompiled IR Distribution (#195)]].

## Pipeline IR fields (RED-381)

A Pipeline IR has `kind: "Pipeline"` and a structurally distinct top-level shape from gens — no `steps`, no `returnSchemaId`, no `enrichments`/`signals`/`triggers`. The runner dispatches operators in declaration order; sub-gen IRs are compiled on demand at each step's dispatch.

| Field | Source primitive | Notes |
|---|---|---|
| `kind` | (discriminant) | `"Pipeline"` literal — `ir.kind === "Pipeline"` routes to `runPipelineFromIr` |
| `version`, `name`, `entry` | core | `entry.source` is the `.pipeline.rb` path; `name` mirrors `entry.class` for trace observability |
| `input` | `input :name, schema: X` | `Record<string, { schema: string }>` — declared input slots. Schemas validated against `src/contracts.ts` at compile time. Single-slot pipelines accept the CLI `--arg` value as that slot; multi-slot expect a JSON object supplying **every** declared slot — there is no `optional:` or `default:`, and a parseable object that leaves one unbound raises (#226). |
| `policies.budget` | `budget tokens: N, tool_calls: N` | `{ tokens?: number, tool_calls?: number }` — pipeline-level cap (ceiling, not quota). Pre-dispatch token check via projection from each sub-gen's `model.max_tokens`; post-step tool-call check. |
| `policies.security` | `security :pack_name` or `security network: {...}` | inherited into every sub-gen by default; sub-gen `security` blocks override per-slot. Same per-slot mixing rule as gen-side (RED-214). |
| `policies.bind_defaults` | `bind_defaults :explicit | :pass_through` | `:explicit` (shipped default) or `:pass_through` (prior step's output flows into next step's primary input slot). |
| `policies.memory[]` | `memory :name, strategy: :sym, ...` | pipeline-level memory slots (pipeline-authoritative on strategy/embed/keyed_by/retain). Sub-gens opt in via `memory :name, scope: :pipeline_run`. Bucket keyed by the pipeline's run id; all sub-gens of one run share the bucket. |
| `policies.schedules[]` | `cron :daily, at: "9:00"` | same shape as gen `policies.schedules[]`; `cambium schedule list/compile` recognizes `.pipeline.rb` alongside `.cmb.rb` (RED-381 Phase F.1). |
| `policies.log[]` | `log :datadog, ...` | same shape as gen `policies.log[]`. Run-level events use `<snake_pipeline_name>.<method>.<event>` (`complete` / `failed`). |
| `operators[]` | `step`, `fan_out`, `branch_on` | typed entries: `{ kind: "Step", id, gen, method, with[] }`, `{ kind: "FanOut", id, branches[], concurrency?, on_branch_failure, require, context?, collect_into, _homogeneous?, prewarm? }`, `{ kind: "BranchOn", signal, branches[], default? }`. `with[]` and `signal` carry `bind()` refs cross-validated against input + step outputs at compile time. `prewarm` is emitted whenever explicitly set — `true` or `false`; when unset (the common case) the key is **absent** and the runner defaults to on, so pre-existing pipeline IR stays byte-identical. `false` opts out of the runner's automatic fan-out cache warm-up. |
| `output` | `output do ... end` | optional. `{ kind: "last_step" }` (default) means pipeline output = last step's output. `{ kind: "compose", fields: [{ name, from }] }` means assembled from named bind refs. |
| `context` | runtime `--arg` | `{ "_pipeline_arg": <string> }` — the raw CLI arg. `parsePipelineInputs()` in the runtime maps this to input slots (single slot gets the raw string; multi-slot expects JSON-object). The CLI never substitutes a value for an omitted `--arg`: against a pipeline declaring one or more `input` slots it refuses before dispatch instead (#223); a zero-slot pipeline with no `--arg` still runs, unaffected, with `_pipeline_arg: ""` (`parsePipelineInputs`'s zero-slot branch ignores it). `cambium serve`, `cambium replay`, and library callers of `runPipelineFromIr` supply this field directly and are unaffected by the CLI's refusal — but they **are** subject to the binder's own multi-slot completeness check (#226), which lives in `parsePipelineInputs` and so applies to every caller. |

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
- [[N - Precompiled IR Distribution (#195)]] — running a compiled IR without the compiler present
