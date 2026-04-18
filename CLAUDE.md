# Cambium — Rails for Generation Engineering

You are helping a developer work with **Cambium**, a DSL and runtime for building reliable LLM programs. Cambium compiles Ruby DSL (`.cmb.rb`) to JSON IR, executed by a TypeScript/Node runner with typed contracts, validation, repair loops, and full tracing.

## If the developer is new to Cambium

Walk them through creating their first agent. Use the CLI generators — don't write files manually.

### Step 1: Scaffold an agent
Ask what they want to build, then:
```bash
cambium new agent <AgentName>
```
This creates the `.cmb.rb` file, system prompt, and test.

### Step 2: Define the schema
```bash
cambium new schema <SchemaName>
```
This prints TypeBox boilerplate to add to `packages/cambium/src/contracts.ts`. Help them define the fields their agent should return.

### Step 3: Edit the system prompt
Open `packages/cambium/app/systems/<agent_name>.system.md` and help them write a focused role description.

### Step 4: Create a fixture
Help them create a test document in `packages/cambium/examples/fixtures/`.

### Step 5: Run it
```bash
CAMBIUM_OMLX_API_KEY=<key> cambium run packages/cambium/app/gens/<agent_name>.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/<fixture>
```

### Step 6: Iterate
Look at the trace (`runs/<run_id>/trace.json`) and help them tune the agent — add constraints, correctors, signals, grounding.

## Key concepts

- **GenModel**: a Ruby class that declares an LLM program with contracts
- **`returns`**: typed output schema (TypeBox → JSON Schema → AJV validation)
- **`uses`**: tool access (deny-by-default, logged, typed)
- **`corrects`**: deterministic post-validation transforms (math, dates, currency, citations)
- **`constrain`**: runtime behavior changes (tone, compound review, consistency, budget)
- **`extract` + `on`**: signals extracted from output trigger deterministic actions
- **`enrich`**: sub-agent digests raw context before main generation
- **`grounded_in`**: citation enforcement with verbatim quote verification
- **`mode :agentic`**: multi-turn tool-use loop (model calls tools during generation)
- **`system`**: `:symbol` resolves to `app/systems/<name>.system.md`, string is inline
- **`security`** / **`budget`**: tool-execution policy + per-tool/per-run call caps. Inline form (`security network: { allowlist: [...] }`) or pull a bundled pack by symbol (`security :research_defaults` → `app/policies/<name>.policy.rb`). Per-slot mixing rule: each slot is set by exactly one source. See [`docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md) and [`P - Policy Packs (RED-214)`](docs/GenDSL%20Docs/P%20-%20Policy%20Packs%20%28RED-214%29.md).
- **Plugin tools**: adding a new tool is a paired set of files in `app/tools/` — `<name>.tool.json` (schema + permissions) and `<name>.tool.ts` (handler exporting `execute(input, ctx?)`). The registry auto-discovers both; no edits to `packages/cambium-runner/src/tools/index.ts` needed (RED-209). A plugin tool with the same name as a framework builtin wins — that's the override hook.
- **`memory`** *(RED-215 phases 2–5 — declare, execute, retro agents, semantic)*: declare per-gen memory slots (`memory :conversation, strategy: :sliding_window, size: 20` / `memory :facts, strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"` / `memory :activity, strategy: :log`). Scopes are `:session`, `:global`, or a named pool defined under `app/memory_pools/<name>.pool.rb`. The pool is authoritative on strategy/embed/keyed_by; the gen can only add reader knobs (`size`, `top_k`). At run time the runner opens one SQLite file per bucket (`runs/memory/<scope>/<key>/<name>.sqlite`), reads from it per strategy (`:sliding_window` → last N; `:semantic` → vec-search against `ctx.input`; `:log` → no read), injects the hits as a `## Memory` block in the system prompt, and — after a successful run — either appends one `{input, output}` entry (trivial default) or invokes the retro agent named by `write_memory_via :SomeAgent`. Retro agents have `mode :retro` + `reads_trace_of :primary` + `returns MemoryWrites`; their entry method is always `remember(ctx)` (Rails `ActiveJob#perform` analogue). Agent-written entries tag `written_by: 'agent:<ClassName>'`; failures never propagate to the primary (best-effort writes). Session id comes from `CAMBIUM_SESSION_ID` or is auto-generated and echoed to stderr. `--memory-key name=value` supplies values for `keyed_by` slots. Memory subsystem deps (`better-sqlite3`, `sqlite-vec`) are `optionalDependencies` — installs without memory use never pay for the native build. See [`P - Memory`](docs/GenDSL%20Docs/P%20-%20Memory.md).

## CLI commands

```bash
cambium run <file.cmb.rb> --method <method> --arg <path>   # compile + execute
cambium compile <file.cmb.rb> --method <method> [-o <ir.json>] # emit IR JSON without executing (engine-mode build step, RED-244)
cambium new engine|agent|tool|schema|system|corrector <Name>   # scaffold (deterministic)
cambium new engine <Name>                                    # new engine folder under ./cambium/ (RED-246)
cambium new tool --describe "<description>"                 # agentic tool scaffolder (RED-216)
cambium test                                                 # run test suite
```

## Project structure

```
packages/cambium/
  app/
    gens/           # GenModel DSL files (.cmb.rb)
    systems/        # System prompts (.system.md)
    tools/          # App plugin tools — paired .tool.json + .tool.ts (auto-discovered)
    policies/       # Policy packs (.policy.rb) — bundled security + budget
    memory_pools/   # Named memory pools (.pool.rb) — shared strategy+embed+keyed_by (RED-215)
  src/
    contracts.ts    # TypeBox schemas (single source of truth)
  tests/            # Vitest tests
  examples/
    fixtures/       # Test documents
packages/cambium-runner/   # @cambium/runner — TS runtime (RED-242)
  src/
    runner.ts         # TS runtime (executes IR)
    step-handlers.ts  # Generate, validate, repair, correct handlers
    builtin-tools/    # Framework-provided tools (RED-221): calculator, read_file,
                      # web_search, web_extract, execute_code — same plugin layout
                      # (.tool.json + .tool.ts) as app tools. App tools override
                      # framework builtins with the same name.
    tools/            # Tool framework infrastructure (registry, ToolContext,
                      # network-guard, permissions — NOT handlers)
    correctors/       # Built-in correctors (math, dates, currency, citations)
    signals.ts        # Signal extraction engine
    triggers.ts       # Trigger evaluation engine
    compound.ts       # Review + consensus engines
    enrich.ts         # Sub-agent enrichment
    schema-describe.ts # Auto-generated schema descriptions
ruby/cambium/
  runtime.rb        # GenModel DSL primitives
  compile.rb        # Ruby → JSON IR compiler
runs/               # Execution artifacts (ir.json, trace.json, output.json)
docs/GenDSL Docs/   # Full knowledge graph
```

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
- Providers supported for agentic mode:
  - **oMLX** (OpenAI-compatible): `CAMBIUM_OMLX_BASEURL` (default `http://100.114.183.54:8080`), optional `CAMBIUM_OMLX_API_KEY`. Model id: `"omlx:<name>"`.
  - **Ollama**: `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`), no API key. Model id: `"ollama:<name>"` or a bare `"<name>"` (Ollama is the default when no `provider:` prefix).
- Qwen 3.5 thinking mode (oMLX): suppressed via `/no_think` token + `chat_template_kwargs`
- VS Code: syntax highlighting + LSP (hover, go-to-definition, completions) for `.cmb.rb`

## For contributors

The section above orients new users. This section is for anyone modifying Cambium itself (including Claude).

### Specialist agents

Dedicated Claude Code sub-agents live in `.claude/agents/`. Invoke them (via the `Agent` tool with `subagent_type:`) for concentrated context on specific concerns:

- **`cambium-security`** — reviews changes that touch tool dispatch, egress, the `security`/`budget` policy surface, tool registration, or code-generation paths. Enforces the 27 invariants locked in by RED-137 (SSRF guard, IP pinning, dispatch-site gates, budget pre-call checks), RED-214 (per-slot mixing, pack-name regex), RED-209 (plugin permission honesty), and RED-222 (scaffolder path-traversal + overwrite protection). **Use proactively** when modifying `packages/cambium-runner/src/tools/**`, `packages/cambium-runner/src/step-handlers.ts`, `packages/cambium-runner/src/runner.ts`, `packages/cambium-runner/src/triggers.ts`, adding a `*.tool.json` / `*.tool.ts` / `*.action.json` / `*.action.ts` / `*.policy.rb`, or changing the Ruby DSL's `security`/`budget` shape.
- **`cambium-docs`** — reviews the same-PR alignment between code and docs. Catches stale wikilinks after a rename, new DSL methods in `runtime.rb` that aren't documented, new IR fields missing from `C - IR`, new trace step types missing from `C - Trace`, and README project-structure tree drifting behind disk layout. **Use proactively** when modifying `ruby/cambium/runtime.rb`, `ruby/cambium/compile.rb`, `packages/cambium-runner/src/runner.ts` / `packages/cambium-runner/src/step-handlers.ts` / `packages/cambium-runner/src/triggers.ts` (new trace types), adding/renaming files under `docs/GenDSL Docs/`, or touching `CLAUDE.md` / `README.md`. Calibrated to flag user-visible misalignments, NOT prose or style nits.

### Non-obvious invariants

Things that will bite you if you don't know them:

- **Egress is enforced at fetch time, not at startup.** The static check in `validateToolPermissions` is an early warning. The real gate is `checkAndResolve` + `guardedFetch`. Tools that call `globalThis.fetch` bypass the entire guard — they must go through `ctx.fetch`. See `docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`.
- **Budget check happens before dispatch.** `handleToolCall` calls `budget.checkBeforeCall(toolName)` before invoking the tool. Reordering this lets a tool run once past its cap.
- **Budget violations terminate agentic loops.** When `checkBeforeCall` throws mid-loop, `budgetExhausted` flips true and the next turn forces final output. Without this the model retries the refused call indefinitely.
- **The old flat `security allow_network: true` / `allow_filesystem: true` / `allow_exec: true` / `network_hosts_allowlist: [...]` shapes are removed.** The Ruby DSL raises `ArgumentError` on them. Don't reintroduce these anywhere.
- **`parseBudget` accepts both the new `policies.budget` shape and the legacy `policies.constraints.budget`.** Needed for back-compat with `gaia_solver`.
- **`security exec: { allowed: true }` silently resolves to `runtime: 'native'` (RED-248 back-compat).** The `:native` substrate is unsandboxed; every dispatch emits a `tool.exec.unsandboxed` trace step + a one-per-run stderr warning. If you see `tool.exec.unsandboxed` in a trace, a gen is running `execute_code` without a sandbox. The rewrite is in `Normalize.normalize_exec` in `ruby/cambium/runtime.rb`. Don't remove the back-compat — it keeps existing in-tree gens compiling — but understand the tradeoff.
- **`CAMBIUM_STRICT_EXEC=1` promotes `:native` to a hard compile error (RED-249).** Opt-in env var. A shop that wants to block the fig-leaf path across the board sets this in CI; legacy `{ allowed: true }` gens fail at compile with `blocked by CAMBIUM_STRICT_EXEC=1`. Off by default — turning it on today breaks in-tree gens that still use the legacy shape.
- **`execute_code` refuses to dispatch without a `security exec:` block (RED-248).** Calling the tool with no `execPolicy` on ctx (either `{ allowed: true }` or the new `{ runtime:, ... }` shape) throws a hard error rather than silently running native. This is deny-by-default — a gen that declares `uses :execute_code` with no `security exec:` block will fail at runtime with a clear pointer to the fix.
- **WASM substrate uses `quickjs-emscripten`, not Wasmtime (RED-254).** The design note originally said "Wasmtime + QuickJS-WASM" but the shipped stack is QuickJS compiled to WebAssembly, hosted on Node's built-in `WebAssembly` support via the `quickjs-emscripten` npm package. Memory + wall-clock are enforced; CPU is accepted in the DSL but NOT enforced by `:wasm` (only `:firecracker`). No WASI preopens in v1 — filesystem capability is v1.5+. The `available()` probe uses `createRequire(import.meta.url)` because the package is ESM and a bare `require.resolve` would throw ReferenceError.
- **Firecracker snapshot cache keys on `(rootfs, kernel, canonical machine-config)` content hashes (RED-256).** The cache doesn't key on the Firecracker binary version — stale entries from a previous Firecracker release could silently load against a new binary with incompatible snapshot format. Operator-side migration after any Firecracker upgrade: `rm -rf $CAMBIUM_FC_SNAPSHOT_DIR/` (or the default `packages/cambium-runner/var/snapshots/`). The default cache root lives under `packages/cambium-runner/var/` so a workspace wipe takes it out along with other runtime scratch. The SHA-256 + 16-hex cache key is collision-resistant for workspace-local use but not bumped on FC version change.
- **Firecracker `non_canonical_sizing` is fail-open, not fail-closed (RED-256).** A gen requesting any `cpu` / `memory` that normalizes to something other than `(vcpu=1, mem=512 MiB)` silently bypasses the snapshot path and cold-boots, recording `ExecSnapshotFallback.reason = non_canonical_sizing` in the trace. This is intentional — cold-boot is always available — but it means performance expectations that assume warm-restore don't hold for non-standard sizing. The gap is invisible unless you're grepping `trace.json`. The canonical shape is locked in `firecracker-snapshot.ts` as `CANONICAL_VCPU` / `CANONICAL_MEM_MIB`; widening to a `(cpu, memory)` matrix is out of scope for v1.5.
- **Policy packs use per-slot mixing (RED-214).** `security` and `budget` accept either a Symbol pack name (`security :research_defaults`) or kwargs, but never both in one call. Across calls, each slot (`network` / `filesystem` / `exec` / `per_tool` / `per_run`) can be set by exactly one source — pack OR inline. The accumulator `_cambium_add_slots` is the enforcement point. The IR carries `_packs: [...]` listing contributing pack names; this is trace-only metadata — nothing on the TS side reads it for control flow.
- **Pack file names are restricted to `/\A[a-z][a-z0-9_]*\z/`.** A symbol like `:"../foo"` would otherwise interpolate into `File.join` and escape `app/policies/`. The check lives in `PolicyPack.load`. Don't relax it.
- **Memory pool file names share the same regex guard (RED-215).** `MemoryPool.load` uses the identical `/\A[a-z][a-z0-9_]*\z/` check before `File.join(dir, "#{name}.pool.rb")` for exactly the same path-traversal reason. Pool files are evaluated with `instance_eval` inside `MemoryPoolBuilder` — same model as `PolicyPackBuilder`. If you add new Ruby eval contexts loaded by symbol, copy both guards (regex + `CompileError` wrapping around `ScriptError/StandardError`).
- **Memory pools are authoritative on `strategy`/`embed`/`keyed_by`/`retain` (RED-215, extended RED-239).** When a gen does `memory :x, scope: :named_pool`, those four slots come from the pool; attempting to set any of them at the gen site is a compile error. Reader knobs (`size`, `top_k`) stay on the memory decl. Enforced by `MemoryPool::POOL_OWNED_SLOTS` + the resolution loop in `compile.rb`. Same per-slot "exactly one source" stance as RED-214, applied per-decl rather than across a primitive. If `retain` ever needs to be "tightenable" on the gen side, that requires a new `POOL_TIGHTENABLE_SLOTS` concept — don't just remove `retain` from the owned list.
- **Memory TTLs are bounded at both ends (RED-239).** `Retention.parse_duration!` rejects zero durations (silent no-op hides misconfigurations) AND values above 10 years (TS `Date.now() - ttl * 1000` overflows `Number.MAX_SAFE_INTEGER` near that horizon and crashes `toISOString()`). The 10-year cap is documented in `runtime.rb` as `MAX_TTL_SECONDS`. Don't widen it without also widening the TS arithmetic.
- **Prune runs in one transaction (RED-239).** `SqliteMemoryBackend.prune` wraps both the TTL-delete and the cap-delete phases in a single outer `db.transaction(...)`. An abnormal process exit mid-prune leaves the bucket in its pre-prune state — never half-pruned. Do not split the two phases into separate transactions.
- **Workspace memory policy is enforced at compile time, never overridable per-gen (RED-239 v2).** `app/config/memory_policy.rb` (optional file) declares `max_ttl`/`default_ttl`/`max_entries`/`ban_scope`/`require_keyed_by_for`/`allowed_pools`; `Cambium::MemoryPolicy.apply!` runs at the end of memory resolution in `compile.rb` and raises `CompileError` on any violation. There is no per-gen escape hatch — matches the RED-214 policy-pack stance that "policy is policy." Defaults (`default_ttl`) are applied BEFORE enforcement so a default-filled retain still trips `max_ttl` if it would violate it, and `default_ttl ≤ max_ttl` is validated at policy load. Pools are checked before decls so pool-source-of-truth errors surface with the pool's name, not the decl's.
- **Memory `--memory-key` values AND `CAMBIUM_SESSION_ID` are both restricted to `/^[a-zA-Z0-9_\-]+$/` with a 128-char max (RED-215 phase 3).** Both flow into `node:path.join` as directory segments under `runs/memory/<scope>/<key>/`; `node:path` normalises `..` rather than rejecting it, so the validator in `packages/cambium-runner/src/memory/keys.ts#validateSafeSegment` is the only guard. Don't relax the regex or length cap without adding an explicit sanitizer at the path-join site. Backend handles are also registered in `process.once('exit', ...)` in `runner.ts` so every exit path flushes SQLite WAL cleanly.
- **`:semantic` memory is a plan-time error, not a silent no-op (RED-215 phase 3).** `planMemory` throws on any `:semantic` decl with a "phase 5" message. Silent skip would hide broken gens; the error forces the author to either remove the decl or wait for phase 5.
- **Memory writes are post-success only.** `commitMemoryWrites` only fires when `finalOk === true`. A failed validation/repair run does not append to the log. This preserves "memory reflects what the gen actually produced" — otherwise retries would pile junk entries.
- **Retro-agent failures never fail the primary run (RED-215 phase 4).** Every failure path in `runner.ts`'s retro-agent block — agent file not found, subprocess crash, output not parseable, `writes[]` missing, unknown-memory-slot writes — emits a trace step with `ok: false` and proceeds. The primary has already returned a valid answer; memory loss is graceful degradation. If you find yourself wanting to throw instead of trace, write a new invariant note first explaining why this case is different.
- **Retro agents always enter via `remember(ctx)` (RED-215 phase 4).** This is Cambium's ActiveJob#perform convention. Don't make it configurable. The agent's class name is resolved from `write_memory_via :ClassName` → `classNameToFileBase` → `<snake_case>.cmb.rb` under the primary's `app/gens/` sibling or the workspace default. Search logic lives in `packages/cambium-runner/src/memory/retro-agent.ts#findRetroAgentFile`.
- **`mode :retro` suppresses memory machinery for that gen (RED-215 phase 4).** The guard in `runner.ts` (`const memoryDecls = isRetroMode ? [] : ...`) prevents a retro agent from triggering its own memory reads/writes — both because it doesn't make sense semantically and because a retro agent accidentally declaring `write_memory_via` would otherwise recurse.
- **Memory deps are `optionalDependencies` (RED-215 phase 5).** `better-sqlite3` and `sqlite-vec` are loaded via `await import(...)` inside `packages/cambium-runner/src/memory/backend.ts`. A gen that doesn't declare `memory :...` never triggers the import. A gen that does and can't load the deps gets a clear "install with: npm install better-sqlite3 sqlite-vec" error at plan time. Keep the runtime import path lazy — moving these back to static imports would break installs where the native binaries can't build.
- **sqlite-vec extension loads are per-connection (RED-215 phase 5).** Every `SqliteMemoryBackend` instance that touches `entries_vec` must call `initSemantic` first. The module handle is cached via `loadSqliteVec()` but the actual `sqliteVec.load(db)` runs once per `Database` instance, tracked by `_vecLoaded`. Meta pinning (embed_model, embed_dim) is one-time; the extension load is every-connection. This caught us during phase 5 integration testing — a second run opened the bucket, saw meta was already set, skipped the load, and then crashed on `SELECT ... FROM entries_vec`.
- **Embed model pinning is a correctness invariant, not best-effort (RED-215 phase 5).** `initSemantic` rejects a model or dim change with a clear error; the primary run fails (not "best-effort trace"). Mixed-model vectors in one bucket would scramble cosine-distance semantics silently. If a model change is intentional, delete the bucket or use a new memory `name`.
- **Model aliases are resolved at compile time, never at run time (RED-237).** `Cambium::ModelAliases` loads `app/config/models.rb` during Ruby compile and rewrites every `model :symbol` / `embed: :symbol` / bare-name string into its literal `"provider:name"` form before IR emission. The TS runner never sees a Symbol. Don't add runtime alias resolution — it would split the source of truth across two layers and break the "IR is truth" stance. If you need runtime model selection (env override, A/B), do it at IR-post-processing or add a separate mechanism; don't reuse aliases.
- **Tool plugin precedence: plugin handler wins over builtin (RED-209).** `handleToolCall` resolves `registry.getHandler(toolName) ?? builtinTools[toolName]`. A plugin tool in `app/tools/<name>.tool.ts` shadowing a same-named framework builtin is the intended override hook, but it's also a silent invariant-weakening risk — a plugin that bypasses `ctx.fetch` would re-open SSRF. New plugin tools must declare `permissions` honestly in their `.tool.json` and go through `ctx.fetch` for any network access. `cambium-security` reviews flag plugins that miss either.
- **Budget check is the strict first gate.** In `handleToolCall`, `env.budget?.checkBeforeCall` runs before impl resolution, before `ToolContext` construction, before anything else. Reordering this — even if the reorder doesn't functionally bypass the cap — means budget violations no longer surface first in the trace, which breaks observability guarantees.
- **Action dispatch mirrors tool dispatch (RED-212).** `dispatchAction` in `packages/cambium-runner/src/triggers.ts` runs `env.budget?.checkBeforeCall` → resolve def/handler → `buildToolContext` → `handler(input, ctx)` in that order, same as `handleToolCall`. Skipping the budget pre-call or passing a bare `globalThis.fetch` instead of `ctx.fetch` would open the same holes. Unknown-action triggers MUST fail fast at runner startup (not at signal-fire time) — the check is in `runner.ts` right after `ActionRegistry` loads. Don't defer it.

### Tracking

Cambium work is tracked in Linear. Team: **RED** (Redwood Labs), project: **Cambium**. Branch naming: `RED-<NNN>/<short-slug>`. Commit subjects: `RED-<NNN>: <message>`.
