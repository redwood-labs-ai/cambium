# Cambium

**Rails for generation engineering.** Write LLM programs in readable Ruby DSL, compile to auditable JSON, run with typed contracts, tools, repair loops, and full tracing.

## What is this?

Agentic LLM pipelines are hard to get right. Prompts drift. Outputs break silently. Debugging is a nightmare. Cambium gives you the same structure that Rails gave to web apps — conventions, contracts, and a runtime that handles the hard parts so you can focus on the logic.

```ruby
class Analyst < GenModel
  model "omlx:gemma-4-31b-it-8bit"
  system :analyst
  returns AnalysisReport

  uses :web_search, :calculator
  corrects :math

  constrain :budget, max_tool_calls: 4
  grounded_in :document, require_citations: true

  def analyze(document)
    generate "analyze incident transcript" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

That's a complete, runnable LLM program. The compiler turns it into JSON IR. The runner handles generation, validation, repair, tool calls, citations, and budget tracking automatically.

## Key features

- **Typed contracts** — TypeBox schemas define output shape. Validation catches bad outputs before they propagate.
- **Repair loops** — Failed validation triggers targeted repair with configurable stop conditions.
- **Tool use** — Declared, permissioned, logged. No surprise side effects.
- **Citation enforcement** — `grounded_in` verifies quotes exist verbatim in source documents.
- **Agentic multi-turn** — Models that need to call tools mid-generation get a full conversation loop.
- **Full tracing** — Every run produces a `trace.json` with every step, token counts, tool calls, and timing.
- **Correctors** — Deterministic post-processing (math, dates, currency, citations).
- **Signals + triggers** — Extract data from outputs and fire deterministic actions.
- **Budget tracking** — Token limits, tool call caps, time limits. Exceeded budgets fail safely.

## Quick start

```bash
# Prerequisites: Ruby, Node.js, oMLX server (or Ollama)

# Scaffold your first agent
cambium new agent MyAnalyst

# Define a return schema
cambium new schema MyReport

# Add system prompt
cambium new system my_analyst

# Run it
CAMBIUM_OMLX_API_KEY=<key> cambium run \
  packages/cambium/app/gens/my_analyst.cmb.rb \
  --method analyze \
  --arg packages/cambium/examples/fixtures/incident.txt

# Inspect the trace
cat runs/<run_id>/trace.json | jq .
```

## How it works

```
.cmb.rb (Ruby DSL)
    │
    ▼  compile.rb
JSON IR (intermediate representation)
    │
    ▼  runner.ts
┌─────────────────────────────────┐
│  Generate → Validate → Repair   │
│       ↓                         │
│  Correct → Ground → Signals     │
│       ↓                         │
│  Agentic tool loop (optional)   │
└─────────────────────────────────┘
    │
    ▼
output.json + trace.json
```

## Project structure

```
├── packages/cambium/
│   ├── app/
│   │   ├── gens/          # GenModel definitions (.cmb.rb)
│   │   ├── systems/       # System prompts (.system.md)
│   │   └── tools/         # Tool definitions (.tool.json)
│   ├── src/
│   │   └── contracts.ts   # TypeBox schemas (source of truth)
│   └── tests/
├── src/
│   ├── runner.ts          # Core runtime (step pipeline)
│   ├── step-handlers.ts   # Generate, validate, repair, correct
│   ├── inline-tool-calls.ts  # Gemma/XML tool call parser
│   ├── golden.ts          # Golden test framework
│   ├── scripts/
│   │   └── gaia-eval.ts   # GAIA benchmark eval runner
│   └── correctors/        # Built-in correctors
├── ruby/cambium/
│   ├── runtime.rb         # GenModel DSL primitives
│   └── compile.rb         # Ruby → JSON IR compiler
├── cli/
│   └── cambium.mjs        # CLI entry point
├── vscode/cambium-syntax/ # VS Code extension (syntax + LSP)
└── docs/                  # Knowledge graph docs
```

## Development

```bash
npm test              # Run test suite
npm test -- --watch   # Watch mode

# Eval runner (GAIA benchmark)
npx tsx scripts/gaia-eval.ts \
  --questions packages/cambium/examples/gaia-questions/ \
  --expected packages/cambium/examples/gaia-questions/expected.jsonl \
  --output results.jsonl
```

## Docs

Full documentation is in `docs/` — a knowledge graph with stable Doc IDs. Start with:
- `docs/GenDSL Docs/00 - Getting Started.md`
- `docs/GenDSL Docs/01 - Core Concepts.md`
- Spec drafts at `docs/` root level

## Status

v0.2 — working core pipeline. Not published. Private repo.
