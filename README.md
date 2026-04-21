# Cambium

**Rails for generation engineering.** Write LLM programs in readable Ruby DSL, compile to auditable JSON, run with typed contracts, tools, repair loops, and full tracing.

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

That's a complete, runnable LLM program. The Ruby compiler turns it into JSON IR. The TS runner handles generation, validation, repair, tool calls, citations, and budget tracking.

## Install

```bash
# CLI (Ruby DSL + scaffolders + `cambium run`)
npm install -g cambium

# OR: library only (engine-mode hosts that compose IR and invoke runGen directly)
npm install @redwood-labs/cambium-runner
```

### Prerequisites

- **Node.js 18+**
- **Ruby 3.0+** with the `json` gem (`gem install json` if missing) — Cambium ships the Ruby compiler; the Ruby runtime itself is a user-side prerequisite
- An LLM provider — either:
  - **oMLX** (OpenAI-compatible): set `CAMBIUM_OMLX_BASEURL` (default `http://localhost:8080`), optional `CAMBIUM_OMLX_API_KEY`
  - **Ollama**: set `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`)

Run `cambium doctor` to verify your environment.

## 5-minute quickstart

```bash
# 1. Create a new workspace
cambium init my-project && cd my-project

# 2. Scaffold an agent + schema + system prompt
cambium new agent MyAnalyst
cambium new schema MyReport

# 3. Edit the generated files
#    - app/gens/my_analyst.cmb.rb: wire up the generate call
#    - src/contracts.ts: define the schema fields
#    - app/systems/my_analyst.system.md: write the agent's role

# 4. Run it
echo "hello world" > fixture.txt
CAMBIUM_OMLX_API_KEY=<key> cambium run \
  app/gens/my_analyst.cmb.rb \
  --method analyze \
  --arg fixture.txt

# 5. Inspect the trace
cat runs/<run_id>/trace.json | jq .
```

## Key features

- **Typed contracts** — TypeBox schemas define output shape; AJV validates before the output propagates.
- **Repair loops** — Failed validation triggers targeted repair with configurable stop conditions.
- **Tool use** — Declared, permissioned, logged, SSRF-guarded fetch with IP pinning and per-call budgets. Plugin pattern for app tools; bundled policy packs for shared security postures.
- **Citation enforcement** — `grounded_in` verifies quotes exist verbatim in source documents.
- **Agentic multi-turn** — Models that need mid-generation tool calls get a full conversation loop.
- **Memory** — `memory :conversation, strategy: :sliding_window` (or `:log`, `:semantic`) persists across runs; SQLite-backed, vec-search capable, optional deps.
- **Full tracing** — Every run produces a `trace.json` with every step, token counts, tool calls, and timing.
- **Correctors** — Deterministic post-processing (math, dates, currency, citations) with automatic repair loops.
- **Signals + triggers** — Extract data from outputs and fire deterministic actions.
- **Budget tracking** — Token limits, tool call caps, time limits. Exceeded budgets fail safely.
- **Scheduled runs** — `cron :daily, at: "9:00"` declares the schedule; `cambium schedule compile` emits deploy manifests for your platform (k8s CronJob, crontab, systemd, GitHub Actions, Render Cron).
- **Observability** — `log :datadog` ships run + step events with a framework-owned severity mapping so monitors key off real run state.

## How it works

```
.cmb.rb (Ruby DSL)
    │
    ▼  compile.rb (Ruby)
JSON IR (intermediate representation)
    │
    ▼  @redwood-labs/cambium-runner (TypeScript)
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

## Documentation

Full documentation is in [`docs/GenDSL Docs/`](docs/GenDSL%20Docs/) — a knowledge graph of primitives, compilation semantics, and design notes. Start with:

- [`00 - Getting Started.md`](docs/GenDSL%20Docs/00%20-%20Getting%20Started.md)
- [`01 - Core Concepts.md`](docs/GenDSL%20Docs/01%20-%20Core%20Concepts.md)
- [`Generation Engineering DSL — Docs Map`](docs/GenDSL%20Docs/Generation%20Engineering%20DSL%20%E2%80%94%20Docs%20Map%20%28Knowledge%20Graph%29.md)

## Engine mode

Host projects that want to compose Cambium IR and invoke the runtime directly (rather than via the CLI) use `@redwood-labs/cambium-runner` as a library:

```ts
import { runGen } from '@redwood-labs/cambium-runner';
import * as schemas from './schemas.js';

const result = await runGen({ ir, schemas, mock: false });
if (result.ok) {
  console.log(result.output);
}
```

See `docs/GenDSL Docs/N - App Mode vs Engine Mode (RED-220).md` for the full host-integration shape.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the project structure, development loop, and architecture notes.

## License

MIT — see [`LICENSE`](LICENSE).
