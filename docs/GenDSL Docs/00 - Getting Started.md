# Getting Started

**Doc ID:** gen-dsl/getting-started

## Purpose
Get a minimal Cambium app running, producing a typed result with a trace.

## Prerequisites
- Ruby (for the DSL compiler)
- Node.js (for the TypeScript runner)
- Model provider: oMLX server or Ollama

## Hello world flow

One intent, one file: scaffold a gen, declare its schema in the `returns` block, run it — no hand-written TypeScript, no second artifact to keep in sync.

### 1. Scaffold an agent
```bash
cambium new agent MyAnalyst
```
This creates the `.cmb.rb` file in `packages/cambium/app/gens/` (with a starter `returns do … end` schema block) and a system prompt in `packages/cambium/app/systems/`.

### 2. Declare the return schema in the gen
Open the scaffolded gen and edit the `returns` block to describe the output you want:
```ruby
returns do
  field :summary, String
  field :score, Float
  field :tags, [String]
end
```
The runtime validates the model's output against this directly — there is nothing to add to `contracts.ts`. The closed type vocabulary (scalars, arrays, nested blocks, `enum:`, `optional:`, `description:`) is in [[P - returns]]. For a schema the block can't express, fall back to `returns :Symbol` + a hand-written TypeBox contract (`cambium new schema`).

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

### 6. (Optional) Generate typed contracts for consumers
If TypeScript consumers want typed imports, regenerate them from every block-form gen:
```bash
cambium compile --write
```
This writes `packages/cambium/src/contracts.generated.ts` (TypeBox + inferred types) behind a sentinel-header overwrite guard. It is **types-only** — your gen already runs and validates without it — so it's purely for `import { type MyAnalystOutput } from './contracts.generated'`. Never hand-edit it.

### 7. (Optional) Add memory

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

## Migrating an existing app (RED-419)

**Nothing breaks.** Every existing `returns :Symbol` gen compiles and runs exactly as before — the inline block (`returnSchema`) is a parallel, additive branch. Adoption is opt-in **per gen**: when you want the one-file flow for a gen whose schema fits the closed vocabulary, replace `returns :MyReport` with an inline `returns do … end` block and delete the now-unused `MyReport` export from `contracts.ts`. Schemas the block can't express stay on `returns :Symbol` indefinitely — it remains the supported escape hatch, not a deprecated path.

## See also
- [[01 - Core Concepts]]
- [[P - GenModel]]
- [[P - generate]]
- [[P - Memory]]
- [[C - Trace (observability)]]
- [[C - Runner (TS runtime)]]
