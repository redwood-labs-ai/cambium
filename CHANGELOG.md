# Changelog

All notable changes to Cambium are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cambium adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-24

First feature release since the initial npm publish. Both packages bump to
`0.2.0` together — prior releases had the CLI at `0.1.2` and the runner at
`0.1.0` because the three packaging-fix patches (`0.1.1`, `0.1.2`) only
touched the CLI. Unifying the version numbers now removes the skew before
it gets more confusing.

### Added

- **`@redwood-labs/cambium-runner`** — Anthropic Messages API provider
  (RED-321). New `"anthropic:<name>"` model-id path alongside the existing
  `"omlx:<name>"` and `"ollama:<name>"` providers. Works for both
  single-turn generate and agentic tool-use loops.
  - **Prompt caching is on by default.** `cache_control: ephemeral` is
    applied to the system block and the last tool entry, so a stable
    system prompt + tool set pays cache creation once and hits on
    subsequent turns or runs. Cache stats surface as
    `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`
    in the trace.
  - **Env** — `ANTHROPIC_API_KEY` (standard) or `CAMBIUM_ANTHROPIC_API_KEY`
    (override); optional `CAMBIUM_ANTHROPIC_BASEURL` (default
    `https://api.anthropic.com`). Header `anthropic-version: 2023-06-01`.
  - **Model ids** — e.g. `"anthropic:claude-sonnet-4-6"`,
    `"anthropic:claude-opus-4-7"`, `"anthropic:claude-haiku-4-5-20251001"`.
  - **Deliberately non-scope** — no forced-schema / tool-use JSON hack
    (Claude's first-pass JSON + the existing repair loop is enough); no
    embedding provider (Anthropic has no native embeddings API — pair
    with oMLX or Ollama for `embed:`); no SDK dependency (raw fetch,
    matches the other providers).

### Security

- **Anthropic error messages drop the response body.** Anthropic's 401/403
  bodies can echo credential fragments (e.g., last-4 of the API key).
  Non-2xx responses surface only `HTTP <status>`, matching the oMLX pattern.
  Flagged and fixed in the RED-321 security review.
- Follow-up filed as RED-322 — operator-controlled provider base URLs
  (`CAMBIUM_*_BASEURL`) bypass the `guardedFetch` private-range block.
  Low-priority hardening; the existing default URLs are safe.

### Changed

- **`@redwood-labs/cambium`** bumps runner dep pin from `0.1.0` → `0.2.0`.
  No CLI surface changes; the bump is required so the CLI picks up the
  new runner feature.
- `CLAUDE.md`, `README.md`, and `docs/GenDSL Docs/N - Model Identifiers.md`
  updated to document Anthropic alongside oMLX and Ollama.

### Upgrade from 0.1.x

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

Existing gens using `"omlx:..."` or `"ollama:..."` model ids continue to
work unchanged. To try Anthropic, set `ANTHROPIC_API_KEY` and change the
model id on any gen:

```ruby
model "anthropic:claude-sonnet-4-6"
```

## [0.1.2] — 2026-04-24

### Fixed

- **`@redwood-labs/cambium`** — published tarball no longer ships
  `npm-shrinkwrap.json`. The 0.1.1 tarball included a shrinkwrap that
  had been generated in the monorepo-dev context, where
  `@redwood-labs/cambium-runner` is a workspace-linked package. When
  consumers installed 0.1.1, npm honored the shrinkwrap over the
  (corrected) `workspaces`-free manifest and locked consumers into the
  same nested `node_modules/@redwood-labs/cambium/node_modules/@redwood-labs/cambium-runner/`
  shell that 0.1.1 was supposed to fix. 0.1.2 removes
  `npm-shrinkwrap.json` from the tarball's `files:` allowlist entirely.
  The file is renamed back to `package-lock.json` at the repo root —
  it remains the dev-time lockfile but never ships.
- **Pre-publish check**  — `scripts/pre-publish-check.mjs` is the new
  automated gate. It packs real tarballs, installs them into a
  realistic consumer project with unrelated deps, and asserts on the
  installed structure (no nested shells, no shrinkwrap leaks, no
  workspace-source leaks, CLI bin runs, library imports resolve).
  Run via `npm run pre-publish-check`. Required before every publish
  going forward — this is the gate that would have caught both the
  0.1.0 `workspaces` bug and the 0.1.1 shrinkwrap bug.
- `@redwood-labs/cambium-runner` stays at 0.1.0 — unaffected by this
  fix.

### Upgrade from 0.1.0 / 0.1.1

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

If you were hand-removing the nested shell as a workaround
(`rm -rf node_modules/@redwood-labs/cambium/node_modules`), the
upgrade makes that unnecessary — the installed layout is correct
from the start.

## [0.1.1] — 2026-04-23

### Fixed

- **`@redwood-labs/cambium`** — published tarball no longer carries the
  `workspaces: ["packages/*"]` field. The field is a monorepo-development
  signal meant for the source root; leaving it in the published manifest
  caused npm to create a hollow nested `node_modules/@redwood-labs/cambium/node_modules/@redwood-labs/cambium-runner/`
  shell when the CLI was installed as a dep inside another project,
  breaking resolution. Adopters who hit this on 0.1.0 can either upgrade
  to 0.1.1 or `rm -rf node_modules/@redwood-labs/cambium/node_modules`
  and let Node's resolver walk up to the hoisted sibling.
  - Added `prepack` / `postpack` scripts (`scripts/prepack.mjs`,
    `scripts/postpack.mjs`) that strip `workspaces`, `devDependencies`,
    and dev-only script entries (`test`, `build`) from the published
    manifest while preserving the working copy for dev.
- `@redwood-labs/cambium-runner` stays at 0.1.0 — the bug was CLI-only
  and the runner doesn't have a `workspaces` field.

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
