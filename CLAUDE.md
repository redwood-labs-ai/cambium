# Cambium — Rails for Generation Engineering

You are helping a developer work with **Cambium**, a DSL and runtime for building reliable LLM programs. Cambium compiles Ruby DSL (`.cmb.rb`) to JSON IR, executed by a TypeScript/Node runner with typed contracts, validation, repair loops, and full tracing.

**Ownership rule for this file**: CLAUDE.md owns *behavior* (what you must do or never do, in-context every session) and *routing* (where facts live); the knowledge graph under `docs/GenDSL Docs/` owns the facts. The invariant stubs below are tripwires, not the spec — follow the pointer before editing the subsystem.

## If the developer is new to Cambium

Walk them through creating their first agent. Use the CLI generators — don't write files manually.

> **Layout note (RED-286):** Cambium supports two project shapes. A `[workspace]` Genfile (the cambium monorepo's own layout) puts the app under `packages/cambium/`; a `[package]` Genfile (external apps, flat layout) puts it at the project root. The paths below use `<app>/` to stand in for either. `cambium new` figures out which and writes to the right place automatically.

### Step 1: Scaffold an agent
Ask what they want to build, then:
```bash
cambium new agent <AgentName>
```
This creates the `.cmb.rb` file, system prompt, and test — including a golden regression test (fixture + snapshot, deterministic via `--mock`; see `P - Golden Tests`).

### Step 2: Define the schema
The scaffolded `.cmb.rb` already has a `returns do … end` block. Edit the `field` declarations inside it to match the output you want:
```ruby
returns do
  field :summary, String
  field :score, Float, optional: true
  field :tags, [String]
end
```
No hand-written TypeScript needed — the block compiles to an inline schema. If the block vocabulary (`String`/`Integer`/`Float`/`Boolean`, arrays, nested objects, `enum:` on String) doesn't cover your schema, run `cambium new schema <SchemaName>` as the escape hatch and switch to `returns :SchemaName`.

### Step 3: Edit the system prompt
Open `<app>/app/systems/<agent_name>.system.md` and help them write a focused role description.

### Step 4: Create a fixture
Help them create a test document in `<app>/examples/fixtures/`.

### Step 5: Run it
```bash
CAMBIUM_OMLX_API_KEY=<key> cambium run <app>/app/gens/<agent_name>.cmb.rb --method analyze --arg <app>/examples/fixtures/<fixture>
```

### Step 6: Iterate
Look at the trace (`runs/<run_id>/trace.json`) and help them tune the agent — add constraints, correctors, signals, grounding.

## Key concepts

- **GenModel**: a Ruby class that declares an LLM program with contracts
- **`returns`**: typed output schema. Two forms — an inline `returns do … end` field block (closed vocabulary → Draft-07 JSON Schema inline in the IR, RED-419) or `returns :Symbol` referencing hand-written TypeBox in `contracts.ts` (the escape hatch). Both → AJV validation. See [`P - returns`](docs/GenDSL%20Docs/P%20-%20returns.md).
- **`uses`**: tool access (deny-by-default, logged, typed)
- **`corrects`**: deterministic post-validation transforms (built-ins: math, dates, currency, citations, field_values); error-severity issues feed the repair loop, healed concerns are re-verified, exhaustion emits `CorrectAcceptedWithErrors`. App overrides in `app/correctors/`. See [`P - corrects (correctors)`](docs/GenDSL%20Docs/P%20-%20corrects%20%28correctors%29.md) and [`C - Repair Loop`](docs/GenDSL%20Docs/C%20-%20Repair%20Loop.md).
- **`log`**: per-gen trace fan-out to observability backends (`:stdout`, `:http_json`, `:datadog`, app plugins under `app/logs/`); framework-owned event vocabulary; sink failures never fail the run. See [`P - log`](docs/GenDSL%20Docs/P%20-%20log.md).
- **`cron`**: scheduled-fire declaration (`cron :daily, at: "9:00"` or raw crontab). Cambium owns the semantics; an external scheduler owns the lifecycle (`cambium schedule compile`). See [`P - cron (schedule)`](docs/GenDSL%20Docs/P%20-%20cron%20%28schedule%29.md).
- **`constrain`**: runtime behavior changes (tone, compound review, consistency, budget)
- **`extract` + `on`**: signals extracted from output trigger deterministic actions
- **`enrich`**: sub-agent digests raw context before main generation
- **`grounded_in`**: citation enforcement with verbatim quote verification; `verify: :field_values` adds value-level cross-checks (RED-392). See [`P - grounded_in`](docs/GenDSL%20Docs/P%20-%20grounded_in.md).
- **`mode :agentic`**: multi-turn tool-use loop (model calls tools during generation)
- **`system`**: `:symbol` resolves to `app/systems/<name>.system.md`, string is inline
- **`security`** / **`budget`**: tool-execution policy + per-tool/per-run call caps; inline kwargs or a policy-pack symbol (`security :research_defaults` → `app/policies/<name>.policy.rb`), one source per slot. See [`S - Tool Sandboxing (RED-137)`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md) and [`P - Policy Packs (RED-214)`](docs/GenDSL%20Docs/P%20-%20Policy%20Packs%20%28RED-214%29.md).
- **Plugin tools**: paired `.tool.json` + `.tool.ts` under `app/tools/`, auto-discovered (RED-209); a plugin with a builtin's name wins — that's the override hook.
- **`memory`**: per-gen memory slots (`:sliding_window`, `:semantic`, `:log`) over per-bucket SQLite; scopes `:session` / `:global` / named pools under `app/memory_pools/`; retro write agents via `write_memory_via` (entry method always `remember(ctx)`). Deps are `optionalDependencies`. See [`P - Memory`](docs/GenDSL%20Docs/P%20-%20Memory.md).
- **`Pipeline`**: declarative multi-gen orchestration via `step` / `fan_out` / `branch_on` with rollup IR/trace/budget; lives in `app/pipelines/<name>.pipeline.rb`; **zero inference at the orchestration layer**. Served through the same `/v1/run` endpoint as gens. See [`N - Orchestration Layer`](docs/GenDSL%20Docs/N%20-%20Orchestration%20Layer.md).
- **`cambium replay`** (CLI verb, not a declaration): re-execute a prior run's post-Generate tail against its recorded output, skipping Generate; pipelines resume the operator DAG from the first incomplete operator. See [`P - cambium replay`](docs/GenDSL%20Docs/P%20-%20cambium%20replay.md).

## CLI commands

```bash
cambium run <file.cmb.rb> --method <method> [--arg <path>|-]   # compile + execute (--arg - reads piped stdin)
cambium replay <run-id|path> [--edit] [--from-step <type>] [--from-op <id>] [--mock]   # re-run post-Generate tail (gen) / resume operator DAG (pipeline)
cambium compile <file.cmb.rb> [--method <method>] [-o <ir.json>]   # emit IR JSON; without --method emits a {method → IR} map
cambium compile [--out-dir <dir>] [--write]                    # no file → recompile every gen/pipeline in the workspace (RED-407)
cambium serve --workspace <path> --bind <uri>                  # long-lived HTTP server hosting every exported gen/pipeline (RED-360)
cambium inspect [run-id] [--port <n>] [--runs-dir <path>]      # local read-only trace viewer over runs/; localhost-only by default (RED-313)
cambium new engine|agent|tool|action|schema|system|corrector|policy|memory_pool|pipeline|provider <Name>   # scaffold (deterministic)
cambium new config models|memory_policy                        # scaffold app/config/<form>.rb
cambium new tool --describe "<description>"                    # agentic tool scaffolder (RED-216)
cambium schedule preview <gen.cmb.rb> [--count N]              # next N fires per schedule
cambium schedule list [<gens-dir>]                             # workspace-wide schedule listing
cambium schedule compile <gens-dir> --target <k8s-cronjob|crontab|systemd|github-actions|render-cron>   # emit deploy manifests
cambium test                                                   # run test suite
```

## Project structure

```
packages/cambium/            # the in-tree Cambium app ([workspace] layout)
  app/                       # one dir per object type, all auto-discovered:
                             #   gens/ pipelines/ systems/ tools/ actions/ correctors/
                             #   providers/ policies/ memory_pools/ log_profiles/ logs/ config/
  src/contracts.ts           # TypeBox schemas (single source of truth)
  tests/  examples/fixtures/
packages/cambium-runner/     # @redwood-labs/cambium-runner — TS runtime that executes the IR
packages/cambium-client-python/  # cambium-client — Python client for cambium serve
ruby/cambium/                # GenModel DSL (runtime.rb) + Ruby → JSON IR compiler (compile.rb)
cli/                         # cambium CLI subcommands
runs/                        # execution artifacts (ir.json, trace.json, output.json)
docs/GenDSL Docs/            # the knowledge graph (see Documentation)
```

Full annotated tree: `CONTRIBUTING.md` § Project structure.

## Documentation

Full docs are in `docs/GenDSL Docs/` — a knowledge graph with stable Doc IDs. Start with:
- `docs/GenDSL Docs/00 - Getting Started.md`
- `docs/GenDSL Docs/01 - Core Concepts.md`
- `docs/GenDSL Docs/Generation Engineering DSL — Docs Map (Knowledge Graph).md` (index of all docs)

Prefix key: **P** = Primitive, **C** = Compilation/Runtime, **D** = Data, **S** = Security, **N** = Design Note.

The spec drafts are in `docs/` (root level):
- `docs/Generation Engineering DSL (Rails-style) - Spec Draft.md`
- `docs/Generation Engineering DSL — Reference Implementation (v0).md`

Read these docs before making architectural decisions or adding new primitives.

## Development

- Tests: `npm test` (vitest)
- Ruby 3.x gate (RED-378): `node scripts/test-on-ruby.mjs` runs the suite in a `ruby:<v>-alpine` container (gated step `[7/7]` in pre-publish). Cheap audit-time half: `npm run audit:ruby-compat` (RED-379). Details: `SECURITY.md` § Ruby supply chain.
- Provider dispatch (RED-393): model-id prefixes resolve through a per-run `ProviderRegistry`; app `app/providers/<name>.ts` (filename = prefix) shadows built-ins, and engine-mode gens use `<prefix>.provider.ts` flat siblings (RED-424, same guards + load precedence); author custom providers with the `openaiCompatible` / `anthropicCompatible` factories. See [`N - Model Identifiers`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md).
- Built-in providers for agentic mode:
  - **oMLX** (OpenAI-compatible): `CAMBIUM_OMLX_BASEURL` (default `http://localhost:8080`), optional `CAMBIUM_OMLX_API_KEY`. Model id: `"omlx:<name>"`.
  - **Ollama**: `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`), no API key. Model id: `"ollama:<name>"` or a bare name (Ollama is the default provider).
  - **Anthropic** (RED-321/323): `ANTHROPIC_API_KEY` or `CAMBIUM_ANTHROPIC_API_KEY`; optional `CAMBIUM_ANTHROPIC_BASEURL`. Model id: `"anthropic:<name>"`. Prompt caching on by default (system, tools, and the user-prompt prefix for grounded gens); native PDF/image document input via typed `ir.context` envelopes (Anthropic-only, size-capped). See [`N - Model Identifiers`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md) § Native document input.
- Qwen 3.5 thinking mode (oMLX): suppressed via `/no_think` token + `chat_template_kwargs`
- VS Code: syntax highlighting + LSP (hover, go-to-definition, completions) for `.cmb.rb`

## For contributors

The section above orients new users. This section is for anyone modifying Cambium itself (including Claude).

### Specialist agents

Two sub-agents live in `.claude/agents/`; their frontmatter descriptions (auto-loaded into the Agent tool listing) carry the full file-pattern trigger lists. Routing:

- **`cambium-security`** — run when a change touches tool/action dispatch, egress, the `security`/`budget` surface, policy-pack loading, exec/network/filesystem plumbing, a scaffolder that writes executable files, any new symbol-into-path join site, or any `package.json` dep change.
- **`cambium-docs`** — run when a change adds a DSL primitive / IR field / trace step type, adds or renames a doc, touches CLAUDE.md / README / CONTRIBUTING trees, adds an `app/<type>/` convention dir, or edits the meta surfaces (`cli/generate.mjs`, `cli/lint.mjs`, `vscode/cambium-syntax/**`) that need DSL parity.

**Skip both when** the change is: a one-line fix with no new invariant surface; pure test additions; editor-assist-only edits that don't imply DSL doc drift; behavior-preserving refactors introducing no new symbols / paths / dispatch sites.

**When in doubt, run them** — a clean "0 drifts found" comes back in seconds and is cheaper than missing a drift.

### Non-obvious invariants

Things that will bite you if you don't know them. Each cluster keeps only its behavioral rules and trap symptoms here; the full invariant text lives in the linked docs — read them before modifying the subsystem.

#### Dependency policy (supply-chain defense)

Global — applies to every change. Cambium ships a CLI and runtime others install; one compromised dep in our lockfile compromises every downstream user. Full rationale and attack-class discussion: `SECURITY.md` §§ Supply-chain defenses / Ruby supply chain. The imperatives:

- **Never add a new npm dependency on your own initiative.** It's a user-authorized action — if a task seems to need one, STOP and ask; surface any approved addition explicitly in your response. Prefer Node built-ins (`node:fs`, `node:path`, `node:crypto`, `node:http`; `undici` is already a dep).
- **All deps are pinned exact** — no `^`/`~` anywhere in any `package.json`, including `optionalDependencies`. A range is a regression: restore the pin and check `package-lock.json` matches.
- **Every locked version must be ≥7 days old** (`.npmrc` `minimum-release-age=7` + `scripts/check-dep-ages.mjs` via `npm run audit:ages`). Don't narrow the window; don't widen it without naming the attack class you're trading away.
- **Emergency allowlist** (`CAMBIUM_DEP_AGE_ALLOWLIST`) is for confirmed security patches only — name the advisory in the commit.
- **No bypass via env vars**: `CAMBIUM_DEP_MIN_AGE_DAYS` only tightens (the script refuses values below 1); CI and container builds MUST NOT set `npm_config_*` vars — they silently override the project `.npmrc`.
- **Lockfile is authoritative; never hand-edit it.** Change `package.json`, run `npm install`.
- **Don't introduce `preinstall` / `postinstall` scripts into Cambium itself.**
- **Cambium's Ruby surface is stdlib-only** (`json`, `digest`) — no Gemfile, no Bundler, no gemspec; enforced by `npm run audit:ruby`. Adding a gem takes the same gate as an npm dep. Avoid removed-in-Ruby-3.x constructs — `npm run audit:ruby-compat` enforces a closed pattern enum (RED-379).

#### Tool / action dispatch + egress

Mostly sole-source — this cluster IS the documentation of the gate order until a dispatch doc exists.

- **Egress is enforced at fetch time, not at startup.** `validateToolPermissions` is an early warning; the real gate is `checkAndResolve` + `guardedFetch`. Tools that call `globalThis.fetch` bypass the entire guard — network access must go through `ctx.fetch`. See [`S - Tool Sandboxing (RED-137)`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md).
- **Budget check is the strict first gate.** `handleToolCall` order: `assertAllowed` → get `def` → `env.budget?.checkBeforeCall` → resolve `impl` → AJV input validation (AUD-007, 2026-06-06) → `buildToolContext` → `impl(input, ctx)`. Budget runs before impl resolution, AJV, and context construction — violations always surface first in the trace. (`testOverrideHandlers` tools have no compiled validator and skip AJV.) Do not reorder any of these gates.
- **Budget violations terminate agentic loops.** A mid-loop `checkBeforeCall` throw flips `budgetExhausted`; the next turn forces final output. Without this the model retries the refused call indefinitely.
- **`parseBudget` accepts both `policies.budget` and legacy `policies.constraints.budget`** (back-compat with gaia_solver).
- **The old flat `security allow_network:` / `allow_filesystem:` / `allow_exec:` / `network_hosts_allowlist:` shapes are removed.** The Ruby DSL raises `ArgumentError` on them. Don't reintroduce.
- **Plugin precedence: plugin handler wins over builtin (RED-209).** `registry.getHandler(toolName) ?? builtinTools[toolName]` — the intended override hook, and a silent SSRF re-opening if a plugin bypasses `ctx.fetch`. Plugins must declare `permissions` honestly in their `.tool.json`.
- **Action dispatch mirrors tool dispatch (RED-212).** `dispatchAction` (`triggers.ts`): resolve def/handler → budget pre-call → `buildToolContext` → `handler(input, ctx)` — budget always gates before invocation (it sits after resolution here, unlike `handleToolCall`). Unknown-action triggers fail fast at runner startup, not at signal-fire time.

#### Exec substrate (RED-213+, RED-247–259)

Full invariants: [`S - Tool Exec Sandboxing (RED-213)`](docs/GenDSL%20Docs/S%20-%20Tool%20Exec%20Sandboxing%20%28RED-213%29.md) (substrates, WASM, deny-by-default) and [`S - Firecracker Substrate (RED-251)`](docs/GenDSL%20Docs/S%20-%20Firecracker%20Substrate%20%28RED-251%29.md) (snapshots, filesystem/network allowlists, netns mechanics, operational traps). Danger summary:

- **`security exec: { allowed: true }` silently means unsandboxed `:native`** — every dispatch emits a `tool.exec.unsandboxed` trace step; `CAMBIUM_STRICT_EXEC=1` promotes it to a compile error.
- **`execute_code` with no `security exec:` block refuses to dispatch** (deny-by-default).
- **Firecracker operational traps**: rebuild the rootfs after any `crates/cambium-agent/` change — a stale agent looks like success with surprising guest behavior; wipe `$CAMBIUM_FC_SNAPSHOT_DIR` after a Firecracker binary upgrade (the cache doesn't key on FC version); network-enabled runs are cold-boot-only and not concurrency-safe in v1.

#### Code-gen + path-traversal guards

One pattern, many sites: anywhere a user-picked symbol or string interpolates into a filesystem path, a regex guard runs BEFORE the join — `node:path` and Ruby's `File.join` normalise `..` silently, so the bare join is never safe. **When you add a new symbol-loaded surface, copy the guard** (and for Ruby eval contexts, the `CompileError` wrapping). The sites:

| Surface | Guard | Where |
|---|---|---|
| Policy packs (RED-214) | `/\A[a-z][a-z0-9_]*\z/` | `PolicyPack.load` |
| Memory pools (RED-215) | same | `MemoryPool.load` |
| `grounded_in` source (RED-283) | same | `runtime.rb#grounded_in` |
| Model aliases (RED-237) | same | `Cambium::ModelAliases` |
| Scaffolded tool names (RED-216) | same | `cli/scaffold-tool.mjs` |
| App correctors (RED-275) | basename regex + export-name match + realpath escape check | `correctors/app-loader.ts` |
| `--memory-key` values + `CAMBIUM_SESSION_ID` | `/^[a-zA-Z0-9_\-]+$/`, 128-char max | `memory/keys.ts#validateSafeSegment` |
| `Genfile.toml [types].contracts` (RED-274) | no absolute paths, no null bytes, no `..` escape after resolve | `genfile.ts#resolveGenfileContracts` |
| Custom providers (RED-393/424) | basename regex + realpath escape + export-default + name/filename agreement | `providers/registry.ts#registerFromDir` |

- **App-root resolution is single-sourced**: ALL `app/<type>/` discovery anchors on `ir.entry.source` (walk-up), never `process.cwd()` — cwd is only the last-resort fallback when the source path is unreachable (host-compiled IR in a container). New plugin surfaces must reuse the same `appPkgRoot`/`engineDir` that tools use inside `runGen`; never re-resolve from cwd independently. History + operator contract: [`N - App Mode vs Engine Mode (RED-220)`](docs/GenDSL%20Docs/N%20-%20App%20Mode%20vs%20Engine%20Mode%20%28RED-220%29.md).

#### Memory subsystem (RED-215, RED-239)

Full invariants: [`P - Memory`](docs/GenDSL%20Docs/P%20-%20Memory.md) (pool authority, TTL bounds, transactional prune, workspace policy, retro agents, semantic pinning). Danger summary:

- **Memory writes are post-success only** (`finalOk === true`); retro-agent failures never fail the primary run — trace `ok: false` and proceed.
- **Pools are authoritative** on `strategy`/`embed`/`keyed_by`/`retain`; setting those at the gen site is a compile error. Workspace memory policy (`app/config/memory_policy.rb`) has no per-gen escape hatch.
- **Embed model pinning is a hard correctness invariant** — a model/dim change on an existing bucket fails the run; delete the bucket or use a new memory name.

#### Gen-side compile + runtime invariants

One line per invariant; full text behind each pointer.

- **Per-slot policy mixing (RED-214)**: each slot (`network`/`filesystem`/`exec`/`per_tool`/`per_run`) is set by exactly one source, pack OR inline; `_packs` is trace-only metadata. [`P - Policy Packs (RED-214)`](docs/GenDSL%20Docs/P%20-%20Policy%20Packs%20%28RED-214%29.md)
- **Corrector repair loop (RED-275/296/298)**: after a repair passes schema revalidation, the same corrector MUST re-run (`CorrectAfterRepair`) — skipping it reintroduces the "schema-valid but unhealed" bug; exhaustion emits `CorrectAcceptedWithErrors`; `max_attempts` clamped to [1, 3] on both the Ruby and TS sides. [`C - Repair Loop`](docs/GenDSL%20Docs/C%20-%20Repair%20Loop.md), [`N - Corrector Multi-Attempt (RED-296)`](docs/GenDSL%20Docs/N%20-%20Corrector%20Multi-Attempt%20%28RED-296%29.md)
- **Correctors are per-`runGen`, never module-global (RED-299)**: the registry is built fresh per call; `handleCorrect` / `runCorrectorPipeline` take it as a parameter. A module-global read re-opens silent cross-app overrides. [`P - corrects (correctors)`](docs/GenDSL%20Docs/P%20-%20corrects%20%28correctors%29.md)
- **Every repair-step push goes through `pushRepairStep` (RED-280)** — six sites; the helper pairs the trace push with budget tracking so a new site can't leak spend. [`C - Repair Loop`](docs/GenDSL%20Docs/C%20-%20Repair%20Loop.md)
- **Model aliases resolve at compile time only (RED-237)**: the TS runner never sees a Symbol; don't add runtime alias resolution. [`N - Model Identifiers`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md)
- **Multi-provider fallback (RED-421)**: `model "primary", "fallback1", …` emits `model.fallbacks[]` in the IR; fallback ids resolve at compile time (RED-237) — the runner sees only literal `provider:name` strings, never a Symbol. Transient errors walk the chain in order: HTTP 5xx / 408 / 425 / 429 (`ProviderHttpError`, DEC-A/DEC-C), and connection-level failures — ECONNREFUSED / DNS / TLS / no HTTP response — (`ProviderConnectionError` status 0, DEC-D; built-in providers emit this automatically). Deterministic 4xx fail immediately — a bad request fails on every provider. Custom providers: throw `ProviderHttpError` (typed HTTP status, exported from the runner) for server-error responses; throw `ProviderConnectionError` (also exported; subclasses `ProviderHttpError` with `status: 0`) for pre-response connection failures. A plain `Error` or `TypeError` — any non-`ProviderHttpError` — is classified deterministic (DEC-A unchanged) — prevents a cost-blowing fan-out. The native-document gate fires against the primary provider BEFORE the `--mock` short-circuit. Single-`model` IRs are byte-identical to pre-RED-421 (no `fallbacks` key). [`N - Model Identifiers`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md) § Multi-provider fallback; [`C - IR`](docs/GenDSL%20Docs/C%20-%20IR%20%28Intermediate%20Representation%29.md) § `model.fallbacks`
- **`returns` block → inline `returnSchema`, additive and self-contained (RED-419)**: `returns do … end` emits a Draft-07 schema **inline** in the IR (`returnSchema`, `$id: "<ClassName>Output"`); the runner resolves `ir.returnSchema ?? contractsMod[ir.returnSchemaId]` — inline wins. `returns :Symbol` stays byte-identical (parallel branch, never a rewrite of the symbol path — that's the additive-only constraint). The type vocabulary is a **closed enum** (String/Integer/Float/Boolean, `[T]`, nested/array-of-object blocks, `enum:` on String, `optional:`, `description:`); anything else stays on `returns :Symbol`. Widening the vocab touches the Ruby collector AND the TS emitter AND `P - returns`/`C - IR`. [`P - returns`](docs/GenDSL%20Docs/P%20-%20returns.md)
- **Generated-contracts sentinel: never clobber a non-sentinel file (RED-419/RED-222)**: `cambium compile --write` regenerates `src/contracts.generated.ts` (types-only — runtime uses the inline IR schema, not this file) only in **app mode**, only under **`--write`**, behind the RED-222 guard family: fixed filename anchored on `appPkgRoot` (no symbol-into-path join), `relative()` escape check, and a first-line `@generated by cambium` marker check that **hard-errors** rather than overwrite a hand-authored file. The marker string is a one-way-door contract — changing it orphans existing generated files. [`P - returns`](docs/GenDSL%20Docs/P%20-%20returns.md)
- **Log events: framework-owned vocabulary, fire-and-forget emission (RED-282/302)**: a new event type requires extending the runner AND `C - Trace`; sink errors emit `LogFailed` and never fail the run; profile references inline at compile time. [`P - log`](docs/GenDSL%20Docs/P%20-%20log.md)
- **Cron: Cambium owns semantics, NOT the lifecycle (RED-273/305)**: no in-process scheduler, ever — external schedulers invoke `cambium run ... --fired-by schedule:<id>`, validated against `ir.policies.schedules[]` at startup; `memory scope: :schedule` needs both the compile-time cron pairing and the runtime fired-by guard. [`P - cron (schedule)`](docs/GenDSL%20Docs/P%20-%20cron%20%28schedule%29.md), [`N - Scheduled Gens (RED-273)`](docs/GenDSL%20Docs/N%20-%20Scheduled%20Gens%20%28RED-273%29.md)

#### Pipeline orchestration runtime (RED-374 / RED-381)

Full invariants: [`N - Orchestration Layer`](docs/GenDSL%20Docs/N%20-%20Orchestration%20Layer.md) (budget rollup, advisory concurrency, `branch_on` exhaustiveness, `:pipeline_run` memory plumbing, trace types) and [`C - Serve Mode`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md) (catalog name-uniqueness, extension checks). Danger summary:

- **Zero inference at the orchestration layer is a hard invariant** — LLM calls happen only inside sub-gens via `runGenFromIr`; an operator whose behavior depends on a model decision doesn't ship.
- **Budget rollup is cooperative pre-dispatch, not preemptive** — a sub-gen that starts under budget and overshoots is not interrupted mid-flight; `PipelineBudgetExceeded` fires after, and the next operator never dispatches.
- **New operators require new trace step types** plus a `C - Trace` row — same additivity rule as the gen side.

### Tracking

Cambium work is tracked in Linear. Team: **RED** (Redwood Labs), project: **Cambium**. Branch naming: `RED-<NNN>/<short-slug>`. Commit subjects: `RED-<NNN>: <message>`.
