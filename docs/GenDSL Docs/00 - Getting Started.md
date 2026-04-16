# Getting Started

**Doc ID:** gen-dsl/getting-started

## Purpose
Get a minimal Cambium app running, producing a typed result with a trace.

## Prerequisites
- Ruby (for the DSL compiler)
- Node.js (for the TypeScript runner)
- Model provider: oMLX server or Ollama

## Hello world flow

### 1. Scaffold an agent
```bash
cambium new agent MyAnalyst
```
This creates the `.cmb.rb` file in `packages/cambium/app/gens/` and a system prompt in `packages/cambium/app/systems/`.

### 2. Define a return schema
Add a TypeBox schema to `packages/cambium/src/contracts.ts`:
```ts
export const MyReport = Type.Object({
  summary: Type.String(),
  score: Type.Number(),
}, { additionalProperties: false, $id: 'MyReport' });
```

### 3. Edit the system prompt
Open `packages/cambium/app/systems/my_analyst.system.md` and write a focused role description.

### 4. Run it
```bash
CAMBIUM_OMLX_API_KEY=<key> cambium run \
  packages/cambium/app/gens/my_analyst.cmb.rb \
  --method analyze \
  --arg packages/cambium/examples/fixtures/incident.txt
```

### 5. Inspect the trace
```bash
cat runs/<run_id>/trace.json | jq .
```

### 6. (Optional) Add memory

Memory persists across runs. Add a slot to your agent:

```ruby
memory :conversation, strategy: :sliding_window, size: 20
```

Reuse a session id so subsequent runs see the prior entry:

```bash
export CAMBIUM_SESSION_ID=$(uuidgen)
cambium run packages/cambium/app/gens/my_analyst.cmb.rb \
  --method analyze --arg packages/cambium/examples/fixtures/incident.txt
```

Prior entries are injected as a `## Memory` block in the system prompt on every run. Semantic search (`strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"`) and shared pools (`app/memory_pools/<name>.pool.rb`) are documented in [[P - Memory]]. Memory deps (`better-sqlite3`, `sqlite-vec`) are optional — install them if you use memory.

## See also
- [[01 - Core Concepts]]
- [[P - GenModel]]
- [[P - generate]]
- [[P - Memory]]
- [[C - Trace (observability)]]
- [[C - Runner (TS runtime)]]
