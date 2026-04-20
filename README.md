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
- **Tool sandboxing** — Network egress goes through an SSRF-guarded fetch with IP pinning and per-tool call budgets (RED-137). Bundles available as named policy packs (RED-214).
- **Citation enforcement** — `grounded_in` verifies quotes exist verbatim in source documents.
- **Agentic multi-turn** — Models that need to call tools mid-generation get a full conversation loop.
- **Memory** — Declare `memory :conversation, strategy: :sliding_window` (or `:log`, `:semantic`) to persist across runs; the runtime handles SQLite storage, vec search, system-prompt injection, and post-run writes. Shared pools live in `app/memory_pools/*.pool.rb`; retro memory agents (`mode :retro`) can decide what to remember. Deps are optional — installs without memory don't require the native build.
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

## Memory (opt-in)

Any gen can declare memory slots that persist across runs:

```ruby
class Analyst < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 20
  memory :facts, strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"
end
```

On each run the runtime reads prior entries from `runs/memory/<scope>/<key>/<name>.sqlite`, injects them as a `## Memory` block in the system prompt, and appends a new entry after the run succeeds. Reuse a session across runs by setting `CAMBIUM_SESSION_ID`. Memory deps (`better-sqlite3`, `sqlite-vec`) are **optional** — installs without memory use never pay for the native build.

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
│   │   ├── gens/          # GenModel definitions (.cmb.rb); retro memory
│   │   │                  #   agents (mode :retro) live here too
│   │   ├── systems/       # System prompts (.system.md)
│   │   ├── tools/         # App plugin tools — paired .tool.json + .tool.ts
│   │   ├── actions/       # App trigger actions — paired .action.json + .action.ts
│   │   ├── correctors/    # App corrector plugins (.corrector.ts) — auto-discovered
│   │   │                  #   in app-mode, override built-ins by name (RED-275)
│   │   ├── policies/      # Named policy packs (.policy.rb) for security + budget
│   │   ├── memory_pools/  # Named memory pools (.pool.rb) for shared strategy+embed
│   │   └── config/        # Workspace config — models.rb (RED-237), memory_policy.rb (RED-239)
│   ├── src/
│   │   └── contracts.ts   # TypeBox schemas (source of truth)
│   └── tests/
├── packages/cambium-runner/ # @cambium/runner — TS runtime (RED-242)
│   └── src/
│       ├── runner.ts          # Core runtime (step pipeline + memory lifecycle)
│       ├── step-handlers.ts   # Generate, validate, repair, correct, tool dispatch
│       ├── builtin-tools/     # Framework tools — paired .tool.json + .tool.ts
│       ├── builtin-actions/   # Framework trigger actions (notify_stderr, ...)
│       ├── exec-substrate/    # ExecSubstrate adapter + :wasm/:firecracker/:native (RED-213)
│       │                      #   :firecracker incl. firecracker-{snapshot,allowlist,netns,dns,protocol,api}.ts
│       ├── tools/             # Tool infra (registry, ToolContext, network-guard)
│       ├── actions/           # Action registry (parallel to tools/)
│       ├── memory/            # Memory subsystem (backend, path, keys, retro-agent)
│       ├── providers/         # Model + embed providers (oMLX, Ollama)
│       ├── correctors/        # Built-in correctors (math, dates, currency, citations)
│       │                      #   + app-loader.ts for RED-275 plugin discovery
│       ├── signals.ts         # Signal extraction
│       ├── triggers.ts        # Trigger evaluation (tool_call + action_call)
│       ├── compound.ts        # Review + consensus
│       ├── enrich.ts          # Sub-agent enrichment
│       ├── context.ts         # Grounding-source document lookup (RED-276)
│       ├── genfile.ts         # Genfile.toml [types].contracts resolver (RED-274)
│       └── schema-describe.ts # Auto-generated schema descriptions
├── ruby/cambium/
│   ├── runtime.rb         # GenModel DSL primitives
│   └── compile.rb         # Ruby → JSON IR compiler
├── cli/
│   ├── cambium.mjs        # CLI dispatch
│   ├── compile.mjs        # `cambium compile` subcommand (RED-244)
│   ├── generate.mjs       # `cambium new <type>` scaffolder + engine-mode detection (RED-246)
│   ├── doctor.mjs         # `cambium doctor` env check
│   ├── init.mjs           # `cambium init` workspace bootstrap
│   ├── lint.mjs           # `cambium lint` package validation
│   └── scaffold-tool.mjs  # `cambium new tool --describe ...` agentic scaffolder (RED-216)
├── runs/                  # Execution artifacts (ir.json, trace.json, output.json)
│                          # plus memory/<scope>/<key>/<name>.sqlite buckets
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
