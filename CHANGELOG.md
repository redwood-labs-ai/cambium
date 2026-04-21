# Changelog

All notable changes to Cambium are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cambium adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-21

First public release. Cambium ships as two npm packages:

- **`@redwood-labs/cambium`** — the CLI. Scaffolders (`cambium new ...`),
  compile + run (`cambium run`, `cambium compile`), env check (`cambium
  doctor`), lint, schedule preview/list/compile.
- **`@redwood-labs/cambium-runner`** — the TypeScript runtime. Engine-mode
  hosts `import { runGen } from '@redwood-labs/cambium-runner'` and supply
  their own schemas.

### Core pipeline

- **Typed contracts** — TypeBox schemas → JSON Schema → AJV validation.
  Validation failures feed a configurable repair loop.
- **Tool use** — Declared, permissioned, logged. Framework built-ins
  (`calculator`, `read_file`, `web_search`, `web_extract`, `execute_code`)
  and an app-plugin pattern for custom tools (`app/tools/<name>.tool.ts`).
- **Agentic mode** — Multi-turn tool loop when the model needs to call
  tools mid-generation. oMLX (OpenAI-compatible) and Ollama providers.
- **Correctors** — Deterministic post-validation transforms (`math`,
  `dates`, `currency`, `citations`). Per-corrector `max_attempts` and
  automatic re-run after schema-repair to confirm the concern was healed.
  App-plugin pattern for custom correctors (`app/correctors/<name>.corrector.ts`).
- **Signals + triggers** — Extract data from outputs and fire deterministic
  actions (`extract` / `on`); covers both `tool_call` and `action_call`.
- **Citation enforcement** — `grounded_in` verifies quotes exist verbatim
  in source documents. The source symbol names the context key, so gens
  can ground in any declared document.
- **Compound reasoning** — `review` and `consensus` primitives for
  compose-and-check + N-way agreement.
- **Enrichment** — Sub-agent digests raw context before main generation
  (`enrich`).

### Memory

`memory :conversation, strategy: :sliding_window, size: 20` / `memory :facts,
strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"` / `memory
:activity, strategy: :log`. Scopes: `:session`, `:global`, named pools
(`app/memory_pools/<name>.pool.rb`), and `:schedule` for cron-fired runs.
Retro memory agents (`mode :retro`, `write_memory_via :SomeAgent`) can
decide what to remember. Workspace-wide policy (`app/config/memory_policy.rb`)
enforces TTLs, retention caps, and pool allowlists at compile time.
`better-sqlite3` and `sqlite-vec` are optional deps — installs without
`memory :...` don't need the native build.

### Scheduled runs

`cron :daily, at: "9:00"` or `cron "30 14 * * 1-5"`. Cambium owns the
declaration, IR, and runtime semantics (memory scope `:schedule`,
`trace.fired_by`, `fired_by:schedule` log tag) — but not the lifecycle.
`cambium schedule compile --target <k8s-cronjob|crontab|systemd|github-actions|render-cron>`
emits deploy-ready manifests. Dev-time inspection via `cambium schedule
preview` + `cambium schedule list`.

### Observability

- **`log` primitive** — `log :datadog, include: [:signals, :usage],
  granularity: :run` fans out run events to external platforms. Built-in
  sinks: `:stdout`, `:http_json`, `:datadog` (with framework-owned event
  severity mapping to DD's `status` field). App-plugin pattern for custom
  backends (`app/logs/<name>.log.ts`). Named log profiles bundle shared
  config (`app/log_profiles/<name>.log_profile.rb`).
- **Full trace** — Every run produces a `trace.json` with every step,
  token counts, tool calls, and timing. Event vocabulary is
  framework-owned; sink errors never fail the run (`LogFailed` trace step
  instead).

### Security

- **Tool sandboxing** — SSRF-guarded `ctx.fetch` with IP pinning,
  per-tool and per-run call caps, deny-by-default network/filesystem
  permissions. Bundled named policy packs
  (`security :research_defaults`).
- **Code execution substrate** — `security exec: { runtime: :native | :wasm
  | :firecracker }`. `:wasm` uses QuickJS-on-WebAssembly (memory +
  wall-clock limits). `:firecracker` provides micro-VM isolation with
  snapshot caching, virtio-blk filesystem allowlist, and per-call netns
  network policy. `:native` is explicit-opt-in and emits a trace warning;
  `CAMBIUM_STRICT_EXEC=1` promotes it to a compile error.

### CLI + developer ergonomics

- **Two project shapes** — `[workspace]` monorepo layout (the Cambium
  repo's own shape) and `[package]` flat layout for external apps.
  `cambium new` auto-detects.
- **Engine mode** — Drop-in library consumption. `cambium new engine <Name>`
  scaffolds a folder with sibling schemas, tools, correctors, and gens
  that external hosts consume via `import { runGen }`.
- **Named-symbol discovery** — Policy packs (`security :research_defaults`),
  memory pools (`memory :facts, scope: :shared_pool`), log profiles
  (`log :app_default`), model aliases (`model :fast`), and the
  `write_memory_via :RetroAgent` hook all resolve by symbol at compile
  time.
- **Scaffolders** — `cambium new engine|agent|tool|action|schema|system|corrector|policy|memory_pool|config|log_profile`.
  Agentic scaffolder for custom tools: `cambium new tool --describe "..."`
  drives an LLM to produce the paired `.tool.json` + `.tool.ts`.
- **Lint** — `cambium lint` validates package structure, policy pack
  references, memory pool references, log profile references, and tool /
  action / corrector paired-file consistency.
- **VS Code extension** — Syntax highlighting, hover docs, go-to-definition,
  and completions for `.cmb.rb`.
- **Env discovery** — `.env` walk-up from cwd, framework-`.env` fallback
  for external-app installs, explicit override via `CAMBIUM_DOTENV`.

### Known limitations

- `:firecracker` substrate with network policy does not yet share snapshots
  across network-enabled and network-disabled runs — network-enabled runs
  always cold-boot. Concurrent network-enabled runs are not safe without
  pre-allocated netns names; see `CAMBIUM_FC_PREPARED_NETNS` for the
  operator-managed escape hatch.
- `:wasm` filesystem preopens are deferred to v1.5 — `filesystem:
  { allowlist_paths: [...] }` only takes effect under `:firecracker` in
  this release.
- Latent bug in the citation corrector's fallback path: the fallback
  references `citResult.issues` (top-level) where the field lives at
  `citResult.meta?.issues`. The primary path (`citationResult.allValid`)
  works correctly, so in practice this only affects runs where the
  citations corrector returns no `citationResult` in meta. Flagged as a
  post-v0.1.0 fix.

### Prerequisites

Node.js 18+, Ruby 3.0+ with the `json` gem, and an LLM provider (oMLX or
Ollama). Run `cambium doctor` to verify.
