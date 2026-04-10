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
    tools/          # Tool definitions (.tool.json)
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

- Tests: `npm test` (vitest, 63 tests)
- Model: oMLX server at `CAMBIUM_OMLX_BASEURL` (default `http://100.114.183.54:8080`)
- Qwen 3.5 thinking mode: suppressed via `/no_think` token + `chat_template_kwargs`
- VS Code: syntax highlighting + LSP (hover, go-to-definition, completions) for `.cmb.rb`
