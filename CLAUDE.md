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
- **Plugin tools**: adding a new tool is a paired set of files in `app/tools/` — `<name>.tool.json` (schema + permissions) and `<name>.tool.ts` (handler exporting `execute(input, ctx?)`). The registry auto-discovers both; no edits to `src/tools/index.ts` needed (RED-209). A plugin tool with the same name as a framework builtin wins — that's the override hook.

## CLI commands

```bash
cambium run <file.cmb.rb> --method <method> --arg <path>   # compile + execute
cambium new agent|tool|schema|system|corrector <Name>       # scaffold
cambium test                                                 # run test suite
```

## Project structure

```
packages/cambium/
  app/
    gens/           # GenModel DSL files (.cmb.rb)
    systems/        # System prompts (.system.md)
    tools/          # Tool definitions (.tool.json) + optional handlers (.tool.ts)
    policies/       # Policy packs (.policy.rb) — bundled security + budget
  src/
    contracts.ts    # TypeBox schemas (single source of truth)
  tests/            # Vitest tests
  examples/
    fixtures/       # Test documents
src/
  runner.ts         # TS runtime (executes IR)
  step-handlers.ts  # Generate, validate, repair, correct handlers
  tools/            # Tool implementations + registry
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

- **`cambium-security`** — reviews changes that touch tool dispatch, egress, the `security`/`budget` policy surface, or tool registration. Enforces the 16 invariants locked in by RED-137 (SSRF guard, IP pinning, dispatch-site gates, budget pre-call checks). **Use proactively** when modifying `src/tools/**`, `src/step-handlers.ts`, `src/runner.ts`, adding a `*.tool.json`, or changing the Ruby DSL's `security`/`budget` shape.

### Non-obvious invariants

Things that will bite you if you don't know them:

- **Egress is enforced at fetch time, not at startup.** The static check in `validateToolPermissions` is an early warning. The real gate is `checkAndResolve` + `guardedFetch`. Tools that call `globalThis.fetch` bypass the entire guard — they must go through `ctx.fetch`. See `docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`.
- **Budget check happens before dispatch.** `handleToolCall` calls `budget.checkBeforeCall(toolName)` before invoking the tool. Reordering this lets a tool run once past its cap.
- **Budget violations terminate agentic loops.** When `checkBeforeCall` throws mid-loop, `budgetExhausted` flips true and the next turn forces final output. Without this the model retries the refused call indefinitely.
- **The old flat `security allow_network: true` / `allow_filesystem: true` / `allow_exec: true` / `network_hosts_allowlist: [...]` shapes are removed.** The Ruby DSL raises `ArgumentError` on them. Don't reintroduce these anywhere.
- **`parseBudget` accepts both the new `policies.budget` shape and the legacy `policies.constraints.budget`.** Needed for back-compat with `gaia_solver`.
- **Policy packs use per-slot mixing (RED-214).** `security` and `budget` accept either a Symbol pack name (`security :research_defaults`) or kwargs, but never both in one call. Across calls, each slot (`network` / `filesystem` / `exec` / `per_tool` / `per_run`) can be set by exactly one source — pack OR inline. The accumulator `_cambium_add_slots` is the enforcement point. The IR carries `_packs: [...]` listing contributing pack names; this is trace-only metadata — nothing on the TS side reads it for control flow.
- **Pack file names are restricted to `/\A[a-z][a-z0-9_]*\z/`.** A symbol like `:"../foo"` would otherwise interpolate into `File.join` and escape `app/policies/`. The check lives in `PolicyPack.load`. Don't relax it.
- **Tool plugin precedence: plugin handler wins over builtin (RED-209).** `handleToolCall` resolves `registry.getHandler(toolName) ?? builtinTools[toolName]`. A plugin tool in `app/tools/<name>.tool.ts` shadowing a same-named framework builtin is the intended override hook, but it's also a silent invariant-weakening risk — a plugin that bypasses `ctx.fetch` would re-open SSRF. New plugin tools must declare `permissions` honestly in their `.tool.json` and go through `ctx.fetch` for any network access. `cambium-security` reviews flag plugins that miss either.
- **Budget check is the strict first gate.** In `handleToolCall`, `env.budget?.checkBeforeCall` runs before impl resolution, before `ToolContext` construction, before anything else. Reordering this — even if the reorder doesn't functionally bypass the cap — means budget violations no longer surface first in the trace, which breaks observability guarantees.

### Tracking

Cambium work is tracked in Linear. Team: **RED** (Redwood Labs), project: **Cambium**. Branch naming: `RED-<NNN>/<short-slug>`. Commit subjects: `RED-<NNN>: <message>`.
