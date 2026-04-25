# Changelog

All notable changes to Cambium are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cambium adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-04-25

Patch release. Six adjacent items bundled together: configurable compound
review, real bug fixes in runReview's exception handling, cleaner
thinking-mode suppression, debugger-friendly oMLX errors, provider
base-URL validation, and a notation that 0.3.1 already closed the latent
GroundingCheck dead-code path.

### Fixed

- **`runReview` no longer crashes the host gen on provider failure.**
  runReview is documented as advisory ("review failures should be
  skippable") but pre-0.3.2 a single flaky 30-second API call would
  crash the gen hosting `constrain :compound, strategy: :review`.
  Provider exceptions now produce `{ok: false, meta: { skipped_reason:
  'provider_error', error: <message> }}` and the gen continues to render
  + commit. Trace consumers can branch on `review.ok` to distinguish
  "review ran and found nothing" from "review couldn't run."
- **`runReview` default `max_tokens` raised from 300 → 2000.** 300 was
  too small for any non-trivial review; even a short `{"issues": [...]}`
  envelope with 5–10 items would truncate, silently degrading the
  grounding feedback that flows into repair. The new default fits real
  reviews. Per-gen override available — see Added below.
- **Provider-error ergonomics for oMLX.** Pre-0.3.2 the runner threw
  `oMLX error: HTTP <status>` and `oMLX: missing choices[0].message.content`
  with no upstream body — every provider quirk became a 30-minute
  detective session. Both error paths now include up to 1500 chars of
  the upstream response. Anthropic's path is UNCHANGED — Anthropic 401/403
  bodies can echo credential fragments, so its `HTTP <status>` posture
  from 0.3.0 is preserved.
- **`content || reasoning_content` fallback for OpenAI-compat thinking
  models.** Some Qwen builds leak final output to `reasoning_content`
  rather than `content`. Pre-0.3.2 Cambium failed; now it falls back to
  `reasoning_content` with a stderr warning pointing at `disable_thinking`
  as the cleaner fix. Less correct than fixing the source, but stops a
  silent failure when an unknown thinking-model variant slips past
  auto-detection.

### Added

- **Per-gen review knobs (RED-325 Part 1).** Three optional kwargs on
  `constrain :compound, strategy: :review`:
  - `max_tokens:` — defaults to 2000 (raised from 300)
  - `temperature:` — defaults to 0.1
  - `model:` — defaults to inheriting `ir.model.id`. The high-leverage
    one: a gen running its main call on Sonnet 4.6 can run its review
    on Haiku, cutting review cost ~3-4x without quality loss for
    "internally consistent" checks.
  
  Unknown kwargs raise a clear compile-time error so typos
  (`max_token: 2000`) don't silently fall through to defaults.

- **`disable_thinking` model option (RED-325 Part 3).** Cleaner DSL
  for thinking-mode suppression than the legacy `/no_think` injection:
  
  ```ruby
  model "omlx:Qwen3.5-27B-4bit", disable_thinking: true
  ```
  
  Maps to `chat_template_kwargs.enable_thinking: false` in the request
  body AND injects `/no_think` into both system and user prompts (some
  Qwen builds only respect it in system position). Three signals
  stacked.
  
  **Auto-detection:** if model id matches `/qwen3/i` and the flag isn't
  explicitly set, defaults to `disable_thinking: true` with a one-time
  stderr note. Set `disable_thinking: false` explicitly to opt back into
  thinking.

- **Provider base-URL validator (RED-325 Part 5; absorbs RED-322).**
  `CAMBIUM_*_BASEURL` env vars are validated at first dispatch:
  rejects non-`https://` (except localhost), rejects RFC1918 + 169.254
  + ULA + link-local IPv6 + 127.0.0.0/8 (loopback) + IPv4-mapped IPv6
  to private addresses. Tailscale CGNAT (100.64.0.0/10) is intentionally
  allowed so tailnet/wg-fronted self-hosted models work over https
  without the escape hatch.
  Escape hatch: `CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1` opts in to
  BOTH private-range URLs AND non-https schemes on non-localhost hosts
  (legitimate internal-VLAN proxy setups, Tailscale-CGNAT-over-http).
  Per-(provider, URL, gate) one-time stderr warnings — a URL that trips
  both gates produces two distinct warnings. Closes RED-322.
- **`cambium doctor` now validates base-URL policy, not just reachability.**
  A new check fires the same scheme rule the runner enforces, so a
  misconfigured `CAMBIUM_OMLX_BASEURL=http://example.com` surfaces at
  doctor time rather than at first dispatch.

### Security

- The base-URL validator (Part 5) closes a credential-leak path: a
  poisoned-env CI job or careless deploy manifest setting
  `CAMBIUM_ANTHROPIC_BASEURL=http://169.254.169.254` would silently
  ship the API key to the AWS metadata endpoint. Now rejected before
  the first fetch.
- oMLX error-body inclusion is intentionally NOT extended to Anthropic.
  Anthropic 401/403 responses can echo credential fragments; preserving
  the body-stripped error message protects against trace.json + log-sink
  leaks.

### Changed

- **`@redwood-labs/cambium`** bumps runner dep pin from `0.3.1` →
  `0.3.2`. No CLI surface changes.
- `docs/GenDSL Docs/P - Compound Generation.md` documents the per-gen
  review knobs + the resilience contract (provider failure → skipped,
  not crashed).
- `docs/GenDSL Docs/N - Model Identifiers.md` documents the
  `disable_thinking` model option + the base-URL validator behavior.

### Closes

- **RED-322** (provider base-URL validation) — absorbed into RED-325 Part 5.
- **RED-308** (citation-corrector dead-code path) — already fixed in
  0.3.1's `handleCorrect` meta-merge change. Mentioned here so the
  changelog reflects the closure.

### Upgrade from 0.3.1

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

No breaking changes for gens that don't use `constrain :compound,
strategy: :review` or set custom `CAMBIUM_*_BASEURL` env vars. Gens
using `constrain :compound, strategy: :review` automatically benefit
from the 300 → 2000 default bump and the throw-fix. Gens declaring
unknown kwargs to `constrain :compound, …` (typos, etc.) will start
raising clear compile errors instead of silently falling through.

## [0.3.1] — 2026-04-24

Patch release. Makes `grounded_in` + base64 PDFs actually work, and fixes
a latent bug in the citation-verification path that pre-dates native
document input.

### Fixed

- **`grounded_in :<key>` now works when `ir.context[<key>]` is a
  `base64_pdf` envelope.** 0.3.0 hard-rejected the combination, which
  broke a real downstream use case. The fix extracts the PDF's plain
  text at runtime via `pdfjs-dist` and feeds that text into every
  grounding-aware code path: citation verification, semantic memory
  read, compound review, retro-agent context. Gen authors get native
  Anthropic PDF reasoning AND Cambium's citation guarantee in a single
  pass — no pre-extraction step required.
- **Citation verification was silently always-passing.** An earlier
  refactor dropped each corrector's `meta` when `handleCorrect` wrapped
  its result, so `GroundingCheck.ok` defaulted to `true` regardless of
  whether cited quotes actually appeared in the source document. The
  acknowledged dead-code path (flagged in a `runner.ts` comment) has
  been removed. `handleCorrect` now shallow-merges per-corrector meta
  into its `StepResult.meta`, so the citations corrector's
  `citationResult` reaches the grounding-check consumer and drives the
  real `ok` value. Live verification: a PDF with two sentences that
  the model cites produces `totalChecked=2, passed=2, failed=0,
  allValid=true`.
- **Removed `assertGroundingCompatibleWithDocuments`.** The guard that
  rejected grounded_in + PDF at dispatch time is gone. Callers who
  relied on the error for flow control should switch to trusting the
  citation verifier's actual result.

### Added

- **`pdfjs-dist`** as a regular runtime dependency of
  `@redwood-labs/cambium-runner` (for PDF text extraction). Lazily
  imported — gens that don't use `base64_pdf` never pay the load cost.
- **`extractPdfText(base64, docKey)`** helper in
  `packages/cambium-runner/src/pdf-extract.ts`. Uses the `legacy` build
  of pdfjs-dist for Node compatibility, disables eval/system-fonts
  for defense-in-depth, throws a clear error when a PDF is
  scanned/image-only (OCR is out of scope in v1).
- **`groundingTextByKey` override on `getGroundingDocument`** — the
  runner threads the PDF-extracted text into every grounding consumer.
- **`DocumentExtractionFailed` trace step type** — emitted when
  document extraction throws (malformed base64, oversize, bad PDF).
  Runs fail with `errorMessage: "Document extraction failed: …"` rather
  than proceeding with empty context.

### Changed

- **`extractDocuments` is now async.** The signature returns
  `Promise<{ textContext, documents, groundingTextByKey }>`. Internal
  callers updated; the optional 6th param on `handleGenerate` /
  `handleAgenticGenerate` (`docInput`) lets the runner extract once
  per run and hand the result to both handlers.
- **`@redwood-labs/cambium`** bumps runner dep pin from `0.3.0` →
  `0.3.1`. No CLI surface changes.

### Upgrade from 0.3.0

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

If your gen already uses `grounded_in :<key>` with a `base64_pdf`
envelope, it will start working without changes — you no longer need
to pre-extract text to a separate context key. If your app was
catching the "grounded_in + PDF requires text" error, remove that
error handler.

## [0.3.0] — 2026-04-24

Additive release: native document input for Anthropic.

### Added

- **`@redwood-labs/cambium-runner`** — native base64 PDF + image input
  via `ir.context` typed envelopes (RED-323). Plain-string context
  values continue to flow as text (back-compat). Typed objects
  `{ kind: 'base64_pdf' | 'base64_image', data, media_type }` are
  extracted and emitted as Anthropic Messages-API content blocks, with
  `cache_control: ephemeral` on the last document so bytes are cached
  across agentic turns and repeat runs.
  - **Envelope kinds** — `base64_pdf` (`media_type: application/pdf`),
    `base64_image` (`media_type: image/png`, `image/jpeg`, `image/gif`,
    `image/webp`).
  - **Size caps** — 32 MiB per document (Anthropic's stated PDF limit);
    50 MiB per run total. Override the per-run cap via
    `CAMBIUM_MAX_DOC_BYTES_PER_RUN=<bytes>`.
  - **Base64 strictness** — malformed input is rejected before any API
    call (`base64 data is malformed`, `base64 decoded to suspiciously
    small buffer`, etc.). URL-safe alphabets (`-`/`_`) are accepted as
    input and normalized to standard base64 before dispatch — Anthropic
    rejects the URL-safe form in `source.data`.
  - **Grounding guard** — pairing `grounded_in :<key>` with a base64
    document at the same key raises a compile-style error. Citations
    require text for verbatim quote verification.
  - **Non-Anthropic providers** — `ollama:` and `omlx:` fail fast at
    dispatch with a clear error when documents are present. Don't
    silently JSON-stringify a 30 KB base64 blob into the prompt.
  - **Live smoke verified** — Claude read a synthetic PDF and returned
    the exact embedded secret string; document caching round-trip
    measured at 2308 tokens created → 2308 tokens read on the second
    call.

### Security

- Anthropic provider's documents fail-fast gate runs BEFORE the
  `CAMBIUM_ALLOW_MOCK` early-return, so `--mock` cannot green-light a
  production-broken config (non-Anthropic provider + documents).
  Flagged and fixed in the RED-323 security review.
- The extractor stores the standard-alphabet-normalized base64 in its
  output (not the original URL-safe input), because Anthropic rejects
  `-`/`_` in `source.data`. Flagged and fixed in the RED-323 security
  review.

### Changed

- **`@redwood-labs/cambium`** bumps runner dep pin from `0.2.0` → `0.3.0`.
  No CLI surface changes.
- `docs/GenDSL Docs/C - IR (Intermediate Representation).md` updates the
  `context[<source>]` row to document both value shapes (plain string
  and typed envelope).
- `docs/GenDSL Docs/N - Model Identifiers.md` gains a "Native document
  input (RED-323)" section with envelope shape, wire shape, size caps,
  grounding interaction, and non-Anthropic fail-fast behavior.

### Upgrade from 0.2.0

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

No breaking changes. Existing gens using plain-string `ir.context` values
continue to work unchanged. To pass a PDF or image:

```ruby
generate "analyze the invoice" do
  with context: {
    invoice: {
      kind: "base64_pdf",
      data: Base64.strict_encode64(File.binread("invoice.pdf")),
      media_type: "application/pdf",
    },
  }
  returns InvoiceExtraction
end
```

Requires `model "anthropic:..."`.

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
