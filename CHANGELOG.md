# Changelog

All notable changes to Cambium are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Cambium adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.1] — 2026-06-28 — The Provider Horizon

Parity closes: engine-mode custom providers land with the same guards, scaffolding, and LSP support as app-mode. A community contribution cuts fan-out input costs by more than half, and a security patch rolls undici forward past four advisories.

### Added

- **Engine-mode custom providers via `<prefix>.provider.ts` flat siblings (RED-424).** `runGen` now loads `*.provider.ts` siblings from the engine directory (new `loadFromEngineDir` path in `ProviderRegistry`), enabling `model "myprovider:..."` in engine-mode hosts without an `app/` tree. Only files named exactly `<prefix>.provider.ts` are loaded — non-provider siblings (`schemas.ts`, `index.ts`, etc.) are ignored, closing a file-confusion gap in `loadFromDir`. The same security guards apply: basename regex, realpath escape check, name/filename agreement, dual-method check. Precedence: builtin < app < engine < test-injected. `cambium new provider` scaffolds engine-mode providers, `cambium lint` validates them, and the VS Code LSP resolves their model-id prefixes for hover/goto/completion.
- **Anthropic user-prompt-prefix caching for grounded fan-out gens (PR #18, contrib by kennethsqe).** When a gen has `grounded_in` set and the shared user-prompt payload (DOCUMENT + non-primary context + `OUTPUT_JSON_TEMPLATE`) clears Anthropic's cache floor, `handleGenerate` splits the prompt into a cacheable prefix block and a per-call instruction; the Anthropic provider emits the prefix as a separate text block with `cache_control: ephemeral`. In a fan-out sharing the same grounded document, branch 1 writes the cache and branches 2..N read it — estimated 55–65% input-cost reduction on large fan-out shapes. Non-grounded gens, gens below the cache floor, and non-Anthropic providers receive the byte-identical single-string prompt as before (the runner flattens upstream for providers that don't declare `supportsPromptCacheControl`). The agentic `generateWithTools` path is intentionally unchanged.

### Security

- **undici 8.1.0 → 8.5.0 (CVE-2026-6734 + 3 advisories).** Closes the SOCKS5 connection-pool reuse cross-origin request leak (CVE-2026-6734, GHSA-cxrh-j4jr-qwg3) plus three further advisories including a cumulative-fragment DoS regression specific to 8.1.0. undici backs the runner's SSRF guard (`network-guard.ts`); the `Agent`/`fetch`/`buildConnector` API is unchanged across the minor. 8.5.0 published 2026-06-15, clear of the 7-day age gate; no allowlist needed.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.8.1`.

## [0.8.0] — 2026-06-15 — The Surface Wave

The on-ramp release: declare a gen's output schema in one file, fall over across providers, and pin output with golden regression tests — plus a pipeline correctness fix.

### Added

- **Schema as build artifact (RED-419).** A `returns do … end` field-declaration block declares a gen's output schema in Ruby — closed vocabulary (`String`/`Integer`/`Float`/`Boolean`, arrays, nested objects, array-of-object, `enum:` on `String`, `optional:`, `description:`) — compiled to a Draft-07 JSON Schema inline in the IR plus an auto-generated `src/contracts.generated.ts` (TypeBox + inferred TS types) behind a sentinel-guarded code-gen path (the compiler refuses to overwrite any file lacking the generated-file header). `cambium new agent` now scaffolds the block by default; `returns :Symbol` (hand-written TypeBox in `contracts.ts`) remains supported as the escape hatch.
- **Multi-provider fallback (RED-421).** `model "anthropic:…", "bedrock:…"` accepts an ordered fallback list (varargs). On a *transient* failure of the primary — connection-level errors (surfaced as a typed `ProviderConnectionError`) or HTTP 5xx / 429 / 408 / 425 — the runner walks the chain in order through the per-run `ProviderRegistry`; deterministic 4xx and untyped custom-provider errors fail fast (no fan-out). Adds the additive `model.fallbacks` IR field and a new `ModelFallback` trace step.
- **Golden regression tests are public API (RED-140).** `goldenTest` and the field normalizers (`stripCitations`, `normalizeNumbers`, `normalizeStrings`, `normalizeDates`) are now exported from `@redwood-labs/cambium-runner`. `cambium new agent` scaffolds a golden regression test (fixture + committed snapshot, deterministic via `--mock`).

### Fixed

- **`pass_context` now reaches operators nested inside `branch_on` / `fan_out` (Pipeline).** A `fan_out` nested in a `branch_on` block silently dropped its `pass_context` fields — the pipeline returned `ok` but the nested branch received no upstream context, degrading output with zero signal. The prior-operator inference now threads a running output through operator dispatch instead of an id-search against the top-level operator list.
- **Reconciled the CLI → runner dependency pin** (the `@redwood-labs/cambium` root declared `@redwood-labs/cambium-runner@0.7.1` while the runner shipped `0.7.2`).

## [0.7.2] — 2026-06-08

Patch release. Four fixes surfaced by engine-mode dogfood (`cambium-lnd` v0 on runner 0.6.0→0.7.0) plus a socket.dev hardening item.

### Added

- **`RunGenOptions.persistRun?: boolean` — opt-in run artifact persistence (RED-420 Issue 5).** When `true`, `runGen` writes `runs/<id>/{ir,trace,output}.json` to disk before returning — the same layout the CLI and `cambium inspect` already consume. Defaults to `false`; existing library callers are unaffected. Write failures push a `PersistRunFailed` trace step and never fail the run (same stance as log-sink failures). Eliminates the boilerplate every engine-mode library host was reimplementing to get observable runs.
- **Pre-publish dist/source parity check (`[1.5/6]` in `scripts/pre-publish-check.mjs`).** A new step between pack and install extraction extracts the named exports from four critical `.ts` source files (`field_values`, `network-guard`, `registry`, `wasm`) and verifies each appears in the corresponding `.js` dist file. Catches the 0.6.0 class of divergence where a source fix is present but the committed dist was not rebuilt. Covers `export function/const/class`, `export { Name }` re-exports, and `export type` forms.

### Fixed

- **`smol-toml` missing from `cambium-runner` declared dependencies (RED-420 Issue 2).** `smol-toml` was imported in `dist/genfile.js` and `dist/serve/gen-catalog.js` but absent from `packages/cambium-runner/package.json`'s `dependencies`. Hosts installing the runner without separately vendoring `smol-toml` hit `Cannot find module 'smol-toml'` at runtime. Declared at `1.6.1` (already locked in the monorepo).
- **`log :datadog` endpoint is now required — no silent default (socket.dev hardening).** The runner's `DEFAULT_ENDPOINT` constant (`https://http-intake.logs.datadoghq.com/api/v2/logs`) was hardcoded as a runtime fallback, flagged by socket.dev as a potential telemetry signal. Removed. A `log :datadog` destination without an explicit `endpoint:` now throws a clear error at run time. The `cambium new log_profile` scaffolder already generates `endpoint: ENV["DD_LOG_INTAKE_URL"]` — no template change needed for new projects. **Migration for existing users:** add `endpoint: ENV["DD_LOG_INTAKE_URL"]` (or your region's intake URL) to your `:datadog` destination declaration.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.7.2`. No CLI surface removals.

## [0.7.1] — 2026-06-07

Patch release. Fixes `README.md` missing from both published tarballs — both packages declare an explicit `files` allowlist, which overrides npm's default README-always-included behavior. `README.md` added to the `files` array in each `package.json`. No code changes.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.7.1`. `README.md` added to `files` in both `package.json`s.

## [0.7.0] — 2026-06-07

Minor release. Headliners: **grounding verification is end-to-end**, **the security surface is hardened**, and **the inspect viewer grows a replay shortcut**.

0.6.0 introduced `grounded_in verify: :field_values` — cross-checking structured output values against the grounding document. The gap was the repair loop: if a grounding check raised issues that fed a repair, the corrector didn't re-run against the repaired output. That's fixed. Both citation grounding and field-value grounding now re-verify after any repair that passes schema revalidation, emitting dedicated `GroundingCheckAfterRepair` / `GroundingFieldValueCheckAfterRepair` trace steps. Field-values precision also improves: a new `fields:` allowlist limits checks to named top-level keys, and short values (trimmed length < 3) no longer produce false-positive mismatches.

The security story is a full audit pass (2026-06-06): SSRF hardening for IPv4-mapped IPv6 addresses, fail-closed filesystem policy on empty roots, WASM `evalCode` moved off the main event loop (now runs in a Worker thread with a kill timer), AJV input validation wired into every tool dispatch before `impl` resolution, and a `system :symbol` path-traversal guard that was missing despite the same pattern existing at every other symbol→path join site. The `cambium new tool` scaffolder also gains a red-flag scan that spots `child_process`/`eval`/`spawn` and permission-vs-body mismatches before writing the file.

### Added

- **`grounded_in :source, fields: [...]` — field allowlist for `verify: :field_values` (RED-399).** `grounded_in` gains a `fields:` kwarg accepting an array of symbols. When set, only the named top-level keys of the output are cross-checked against the grounding document; all others skip with reason `not in fields allowlist`. Nested keys inside an allowed top-level key are always checked. Compile-time validation: `fields:` requires `verify: :field_values` (otherwise `ArgumentError`), must be non-empty. Emitted as `ir.policies.grounding.fields` (array of strings). Precision improvement riding alongside: leaf values with trimmed length < 3 now skip with reason `too short for reliable match` — the normalization that trims before matching was already applied to the candidate but not to the minimum-length guard, producing false-positive mismatches on short scalars (single-letter codes, small integers). LSP hover gains the `fields:` line for editor parity. Documented in [`P - grounded_in`](docs/GenDSL%20Docs/P%20-%20grounded_in.md).
- **Replay-from-step button in `cambium inspect` (RED-406).** Gen-run nodes that have a recorded output now display a clipboard-copy button that fills with the ready-to-run `cambium replay <run-id> --from-step <type>` command. Client-only — no new server endpoint. When the selected step type appears more than once in the trace and the node isn't the last of that type, a muted note explains that `--from-step` resolves to the last occurrence (replay addresses by type, not node identity). Documented in [`N - Visual Trace Renderer`](docs/GenDSL%20Docs/N%20-%20Visual%20Trace%20Renderer.md).
- **WASM `evalCode` runs in a Worker thread (AUD-003).** `evalCode` previously ran synchronously on the main event loop — under `cambium serve` mode, a long-running WASM execution blocked all concurrent requests for its duration. `execute_code` now spawns a `worker_threads` worker (`exec-substrate/wasm-worker.mjs`) that receives only `{ code, memory, timeout, maxOutputBytes }` (policy objects are intentionally excluded — `ctx.fetch` and filesystem access are unavailable inside the worker). The parent holds a hard-kill timer at `timeout + 500ms`; the main loop is free the entire time. An event-loop-responsiveness canary in the escape test suite catches any regression back to synchronous dispatch.
- **AJV input validation for tool dispatch (AUD-007).** `loadFromDir` now compiles an AJV validator per tool against its `inputSchema` at load time. `handleToolCall` validates the model-supplied input before impl resolution and before `buildToolContext` — the gate sits between `assertAllowed` / `env.budget?.checkBeforeCall` and `buildToolContext`, preserving the existing dispatch order. A malformed `inputSchema` (that fails AJV compilation) emits a stderr `WARNING` and degrades to no-validation for that tool rather than failing the run. `execute_code.tool.json` gains `maxLength: 1_000_000` on the `code` field. The new gate is documented in the CLAUDE.md dispatch-order invariant cluster.

### Fixed

- **Re-verify grounding after repair (RED-398).** After a grounding-fed repair passes schema revalidation, the same grounding corrector now re-runs. Citation grounding emits `GroundingCheckAfterRepair`; field-value grounding emits `GroundingFieldValueCheckAfterRepair`. Both emit `ok: false` when errors persist (the run is accepted, one attempt, greppable by type) and `ok: true` when the repair resolved all mismatches. The `grounding.fields` allowlist from RED-399 is threaded into the field-values re-verify call. Prior behavior: a grounding-issue → repair → schema-revalidation cycle considered the corrector done after schema revalidation passed, never asking whether the grounding conditions were now satisfied. New trace step types documented in [`C - Trace`](docs/GenDSL%20Docs/C%20-%20Trace%20%28observability%29.md); repair-loop semantics in [`C - Repair Loop`](docs/GenDSL%20Docs/C%20-%20Repair%20Loop.md).
- **Musl-aware `sqlite-vec` load failure message for semantic memory (RED-408).** `initSemantic` now wraps `sqliteVec.load` in a `try/catch` and branches on `detectMuslHost()` (an Alpine/musl loader probe). On a musl system the error names the actual problem — `sqlite-vec` ships no musl build — instead of a raw ELF format error that pointed nowhere useful. Testable without module mocking via a `_testOverrides` seam mirroring `testOverrideHandlers`.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.7.0`. No CLI surface removals.
- `CLAUDE.md` "Non-obvious invariants › Tool / action dispatch + egress" documents the new AJV input-validation gate: position in `handleToolCall` (after budget, before `buildToolContext`), the `testOverrideHandlers` carve-out, and the `!valid`-is-the-sole-gate rule.

### Security

- **SSRF: IPv4-mapped IPv6 bypass closed (AUD-001 + AUD-F1).** `isPrivateIp()` previously extracted the embedded IPv4 from `::ffff:*` addresses before checking CIDRs, but `checkHost()`'s synchronous metadata gate did not — under `block_private: false, block_metadata: true`, the IMDS literal `::ffff:a9fe:a9fe` bypassed `METADATA_HOSTNAMES`. Fix: canonicalize at `checkHost` entry so every downstream check (metadata, denylist, private-range, allowlist) sees the embedded v4 form; the per-path extraction at `isPrivateIp` and the post-DNS loop remains as defense-in-depth. 13 regression tests total across the two fix commits pin the `block_private: false` band specifically. Shared `ip-util.ts` with `extractIPv4MappedV6()` is the single source of truth for the pattern.
- **`read_file` fail-closed on empty roots (AUD-002).** An empty `filesystemPolicy.roots` array previously skipped the roots check entirely, allowing unrestricted reads. Now throws a deny-all error. A boot-time `validateToolPermissions` violation also fires when a filesystem-capable tool's policy declares empty roots — earlier, friendlier failure than the runtime throw.
- **Numeric exec-policy bounds re-enforced in TS (AUD-004).** `permissions.ts` now clamps `cpu`, `memory`, `timeout`, and `maxOutputBytes` to the same numeric ranges the Ruby DSL enforces — a hand-crafted IR with out-of-range values can no longer produce unexpected substrate behavior.
- **`system :symbol` path-traversal guard (AUD-005).** `compile.rb` now applies the same `/\A[a-z][a-z0-9_]*\z/` regex to `system:` symbol names that every other symbol→path join site (policy packs, memory pools, grounded_in sources, model aliases, scaffolded tool names) already required. The gap existed because `system:` was added before the guard pattern was established.
- **`cambium new tool` red-flag scan (AUD-006 + follow-up).** The scaffolder now scans the generated TypeScript source before the write confirm for `child_process`/`eval`/`spawn` patterns and for mismatches between declared `permissions` and body calls that imply filesystem access (`readFile`, `writeFile`, `import fs`, `createReadStream`, `createWriteStream`) — surfaces a warning rather than silently writing a file that would fail a security review later.
- **`execute_code` language enum widened to match handler (AUD-F2).** The `inputSchema` enum was `["python", "node"]`; `normalizeLanguage` accepted `python`, `py`, `node`, `js`, `javascript`. AJV validation (AUD-007) would now reject the extras. Enum widened to match the handler; stale handler comment updated.
- **Inspect viewer XSS: `esc()` on enum fields (AUD-009).** `run.kind`, `run.status`, and node `.status` were rendered without HTML-escaping in `cambium inspect`'s viewer. Wrapped in the existing `esc()` helper.

## [0.6.0] — 2026-05-30

Minor release. Headline: **the run is replayable — and legible**. 0.5.0 made multi-gen orchestration first-class; 0.6.0 makes those compound runs **observable and recoverable**. The trace was always append-only — now it's also a re-execution checkpoint (`cambium replay`) *and* a visual artifact (`cambium inspect`). Pipeline traces compound across steps, fan-outs, and branches; before this release that richness sat inert in JSON. Now you can resume a failed pipeline from its last good step without re-paying upstream cost, and you can open the whole execution graph in a browser to see what each node did.

Riding along: a **pluggable provider registry** (custom model backends without forking the runner), a **value-level grounding mode** (`grounded_in verify: :field_values`), a workspace-wide `cambium compile`, and Ruby 3.x hardening that closes the gap RED-377 bit in 0.4.1 — a docker-test gate plus an audit-time compat lint so the EOL-2.x dev interpreter can never again mask an Alpine/Ruby-3.4 break.

### Added

- **`cambium replay <run-id|path>` (RED-312 + RED-385 Phase A/B).** First-class CLI verb to re-execute a prior run's post-Generate tail (validate → repair → correct → grounding → signals) against its candidate `output.json`, **skipping the expensive Generate** (and the agentic tool loop + enrichments). No model/tool call fires unless a downstream repair genuinely needs one. `--edit` opens the candidate in `$EDITOR` (git-commit-style); `--from-step <type>` resumes a gen from a trace step's recorded output. **Pipelines** resume the operator DAG from the first incomplete operator (or `--from-op <id>`), rehydrating `stepResults` from the per-operator outputs now persisted in the trace (Phase A) — `step` + `branch_on` resume fully; a `fan_out` at/after the resume point re-runs all its branches. The new run's trace carries `parent_run_id` (lineage) + `trace.replay` (pipeline); budget meta seeds from the parent so the cap spans the replay chain. Library equivalents: `runGenFromIr({ ir, candidate, fromStep, parentRunId })` / `runPipelineFromIr({ ir, replay: { priorTrace, parentRunId, fromOp } })`. Full design at [`P - cambium replay`](docs/GenDSL%20Docs/P%20-%20cambium%20replay.md).
- **`cambium inspect` — local visual trace renderer (RED-313).** A drop-in, read-only browser UI that reads the same `runs/<id>/` artifacts the CLI already writes — no new data model, no instrumentation, just a different projection of the trace. `cambium inspect` serves a local SPA (default port 3210) listing the workspace's runs; click one to render its execution graph as an SVG, color-coded by step status, with a per-node side panel of full meta + inputs + outputs. Pipeline nesting (`PipelineRun → PipelineStep → PipelineFanOut → sub-gen`) renders natively. `cambium inspect <run-id>` deep-links a run; `cambium inspect <path>` takes a run directory. Engine mode reads `<engineDir>/runs/`. Auto-refresh via fs-watch → SSE so new runs appear live. Ships as static assets inside the published CLI tarball — no build step, no framework dependency. Documented at [`N - Visual Trace Renderer`](docs/GenDSL%20Docs/N%20-%20Visual%20Trace%20Renderer.md).
- **Pluggable provider registry + custom providers (RED-393).** Every model call now resolves its model-id prefix through a per-run `ProviderRegistry` (`packages/cambium-runner/src/providers/`) instead of a hardcoded if/else chain. Built-ins (`anthropic`, `omlx`, `ollama`) register first; app-supplied `app/providers/<name>.ts` (filename = model-id prefix) shadow them. The dispatcher owns the cross-cutting gates (doc-support, `--mock`, fetch-hint, inline tool-call parsing); a provider does only build→fetch→normalize. Author custom backends (Bedrock, Azure OpenAI, Vertex, self-hosted gateways) with the `openaiCompatible` / `anthropicCompatible` factories (Tier 1) or `defineProvider` (Tier 2) — all exported from `@redwood-labs/cambium-runner`, **zero new dependencies**. App-root anchoring for `app/providers/` discovery is single-sourced on `ir.entry.source` (the run-from-anywhere invariant), with `provider-app-root.e2e.test.ts` guarding the divergent-cwd case. **`cambium new provider <Name>`** scaffolds an `app/providers/` file from the `openaiCompatible` template — the `validateProviderBaseUrl` SSRF guard is pre-wired and the `name` matches the filename — and **`cambium lint`** validates every provider file (basename regex, `export default`, name/filename agreement) before the first model dispatch. See [`N - Model Identifiers`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md) § Custom providers.
- **`grounded_in :source, verify: :field_values` — value-level grounding (RED-392).** Generalizes `grounded_in` from a citation-only primitive into a family of verification modes. The new `field_values` corrector (`packages/cambium-runner/src/correctors/field_values.ts`) cross-checks each structured output field's value against the grounding document via a deterministic normalized-substring match, auto-invoked by `grounded_in verify: :field_values`. Mismatches surface as severity-error issues that feed the existing repair loop. Known v1 precision limitations (false-pass on very short values; no per-field allowlist) are documented in [`P - grounded_in`](docs/GenDSL%20Docs/P%20-%20grounded_in.md) and tracked for a follow-up.
- **`cambium compile` with no file argument — recompile the whole workspace (RED-407).** Changing a workspace-level input (a model alias in `app/config/models.rb`, a memory policy, a shared schema) invalidates every committed `<gen>.ir.json` at once. A bare `cambium compile` now enumerates and recompiles every gen + pipeline in the workspace (from `[exports.gens]` / `[exports.pipelines]` when present, else by scanning `app/gens/` + `app/pipelines/`; engine mode scans `cambium.engine.json` siblings). Engine mode writes each `<base>.ir.json`; app mode validates only (no cruft) unless `--out-dir` / `--write` materializes them. Compiles all-then-reports, exiting non-zero if any file failed. `cambium compile <file>` is unchanged.
- **Ruby 3.x test coverage — pre-publish docker gate (RED-378).** `node scripts/test-on-ruby.mjs [--ruby-version 3.4]` builds a `ruby:<v>-alpine` + Node image and runs `npm ci && npm test` inside it against a clean `git archive HEAD` (no host `node_modules` contamination), reproducing the Alpine/Ruby-3.4 deploy target that RED-377 bit but the EOL-2.x dev interpreter masked. Wired as gated step `[7/7]` in `pre-publish-check.mjs`. (Semantic-memory tests skip under it because `sqlite-vec` ships no musl build — an optional native dep, not a Ruby issue; tracked separately.)
- **Ruby 3.x compat lint — audit-time guard (RED-379).** `scripts/check-ruby-compat.mjs` (`npm run audit:ruby-compat`, folded into `npm run audit:all` and the pre-publish gate) sweeps `ruby/**` for a closed enum of removed-in-3.x patterns: `Proc.new` implicit-block capture (the RED-377 bug — Ruby 3.0), `Kernel#open` URL fetching (3.0), `Object#=~` on non-string receivers (3.2), and the taint mechanism (3.2). Cheap audit-time complement to RED-378's run-it-for-real docker test — defense in depth. The pattern list is closed-enum on purpose; extending it is a deliberate edit, not regex sprawl. Not Rubocop (that's a gem, which would violate the stdlib-only stance).

### Fixed

- **Piped stdin dropped for explicit `--arg -` (RED-397).** `cambium run <gen> --arg -` (the conventional "read from stdin" form) silently discarded piped input. Now forwarded correctly.
- **Retro-memory agents work outside the monorepo (RED-380).** `retro-agent.ts` resolved its `cli/cambium.mjs` spawn target relative to `process.cwd()`, so retro-memory writes only worked when cwd happened to be the Cambium monorepo root. Now resolved relative to the module's own location (`import.meta.url`) with a precedence chain — same family as 0.4.1's `cambium serve` fix.
- **Sub-gen tool discovery from external workspaces (RED-391).** Pipeline sub-gen dispatch now propagates the resolved `workspaceDir` into each sub-gen's `runGen` call, so `app/tools/` (and the other `app/<type>/` plugin surfaces) discover from the gen's own workspace rather than `process.cwd()` — the same source-anchored invariant RED-393 later closed for providers.
- **Ruby stdlib-only compliance: drop `require 'base64'`.** Replaced with core `Array#pack('m0')` to keep the Ruby surface within the stdlib allowlist (`json` + `digest` only) enforced by `scripts/check-ruby-deps.mjs`.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.6.0`. No CLI surface removals.
- **VS Code extension `cambium-syntax`** bumps to `0.7.1` (independent versioning) — grammar + LSP-hover touch-ups for the `field_values` verify mode, plus model-id **provider-prefix completion / hover / go-to-definition** inside `model "<prefix>:..."` and `embed: "<prefix>:..."` literals (RED-401). The LSP now scans `app/providers/*.ts` and offers framework built-ins (`anthropic` / `omlx` / `ollama`) + discovered app providers as prefix completions; hovering a prefix shows its origin; go-to-def on an app-provider prefix jumps to the file. Completes the `app/providers/` meta-tooling parity alongside the `cambium new provider` scaffolder + lint pass.
- `CLAUDE.md` "CLI commands" gains the `cambium replay`, `cambium inspect`, and bare `cambium compile` rows; "Key concepts" gains the `field_values` corrector note and the `grounded_in verify: :field_values` line; "Development" gains the provider-dispatch + Ruby-3.x-gate notes; project-structure tree adds `app/providers/` and the runner `inspect/` + `providers/` source trees.
- `docs/GenDSL Docs/` adds [`P - cambium replay`](docs/GenDSL%20Docs/P%20-%20cambium%20replay.md) and [`N - Visual Trace Renderer`](docs/GenDSL%20Docs/N%20-%20Visual%20Trace%20Renderer.md); `N - Model Identifiers` gains a Custom providers section; `P - grounded_in` documents `verify: :field_values`; `C - Trace` gains the `GroundingFieldValueCheck` row and the replay-lineage fields.
- `README.md` Key features + project-structure tree updated for `cambium inspect`, custom providers, and the runner source layout.

### Security

- **`cambium inspect` is localhost-only and read-only.** No auth, no hosted/multi-user mode, no write surface — running it in a shared environment requires an SSH port-forward, not built-in auth. The server only reads `runs/` artifacts and serves static assets; cambium-security review findings on the inspect server (path handling on the run-id lookup) were addressed before merge.
- **Provider registry preserves all RED-137 dispatch invariants.** Custom providers do only build→fetch→normalize; the dispatcher retains ownership of the egress guard, `--mock` gate, and tool-call parsing. A provider that issued raw `globalThis.fetch` would bypass the SSRF guard — cambium-security review confirmed the built-ins and the factory surface route network access through the dispatcher's fetch path.

## [0.5.0] — 2026-05-20

Minor release. Headline: **the orchestration layer**. `Pipeline` is now a first-class Cambium primitive — a declarative DSL for composing sub-gens via `step` (sequential), `fan_out` (parallel branches with concurrency / threshold / failure modes), and `branch_on :signal` (deterministic conditional routing). Rollup IR / trace / budget owned by the framework. Load-bearing invariant: **zero inference at the orchestration layer** — the DSL compiles to a deterministic IR DAG; LLM calls happen only inside sub-gens. Multi-gen pipelines used to require a `.mjs` driver gluing `runGen` calls together; this release replaces that pattern with a typed, traced, budget-capped primitive that's a peer to `enrich` / `compound` / `cron` / `log` / `memory` in scope and stance.

Also lands five real-world bug fixes surfaced from the PixelWorlds dogfood (the first external downstream app on the orchestration layer), a `grounded_in` ergonomics expansion (the `from:` kwarg loads file contents into the gen IR at compile time), and a Cambium-on-Cambium CI Review pipeline that you can wire into GitHub Actions today to review your own PRs.

### Added

- **`Pipeline` primitive (RED-374 / RED-381).** New top-level DSL class for multi-gen composition. Three operators: `step` (sequential), `fan_out` (parallel; concurrency cap, `require :all | :at_least, N` threshold, `on_branch_failure :continue | :fail_fast`, `pass_context`, homogeneous-fan-out sugar), `branch_on :signal` (deterministic conditional routing; explicit `default do ... end` required in v1). Class-level declarations: `input :name, schema: X`, `output do ... end` (composition), `bind_defaults :explicit | :pass_through`, `budget tokens: N, tool_calls: N` (pipeline-level cap, ceiling-not-quota semantics), `security :pack_name` (inherits into sub-gens with per-slot override), `memory :slot, strategy: :sym` (pipeline-shared scratchpad, see below). 1:1 stance: one class, one method, one operator chain. File location `app/pipelines/<name>.pipeline.rb`. Compile-time validation: bind() refs against input slots + step schemas, branch_on exhaustiveness, branch_on signals must be `bind(:step).field` refs, file basename regex `/^[a-z][a-z0-9_]*$/`, 1:1 enforcement. Trace shape: `PipelineRun` wraps `PipelineStep` / `PipelineFanOut` / `PipelineBranchOn` entries with nested sub-gen traces; `PipelineBudgetExceeded` step type for cap trips. Full design + 20+ load-bearing decisions documented at [`docs/GenDSL Docs/N - Orchestration Layer.md`](docs/GenDSL%20Docs/N%20-%20Orchestration%20Layer.md).
- **Pipeline-shared memory scope `:pipeline_run` (RED-381 Phase E).** New scope keyword alongside `:session` / `:global` / `:schedule` / `<pool_name>`. Pipeline declares the slot with strategy/embed/keyed_by/retain (authoritative); sub-gens opt in via `memory :name, scope: :pipeline_run` carrying reader knobs only (`size`, `top_k`). Bucket lives at `<runsRoot>/memory/pipeline_run/<pipelineRunId>/<name>.sqlite` — all sub-gens of one pipeline run see the same bucket; sub-gens of different pipeline runs see different buckets. Direct `cambium run` of a `:pipeline_run`-scoped gen (outside a pipeline) errors clearly at plan time — silent writes to an unkeyed bucket would be the worst failure mode.
- **`[exports.pipelines]` Genfile section + per-pipeline `cambium serve` endpoints (RED-381 Phase F.3).** Parallel to `[exports.gens]`. Names MUST be unique across the union — duplicates raise at boot. File-extension check (`.cmb.rb` for gens, `.pipeline.rb` for pipelines) enforced. The `/v1/run` wire format's `gen` field carries the catalog name regardless of kind; the server routes by `ir.kind` to either `runGenFromIr` or `runPipelineFromIr`. `/v1/healthz` lists both gen + pipeline names in the catalog response.
- **`cron` + `log` on Pipeline classes (RED-381 Phase F.1+F.2).** Declared on a `Pipeline` class fires the whole pipeline on schedule. `cambium schedule list / compile` walks `.pipeline.rb` files alongside `.cmb.rb`. `--fired-by schedule:<id>` validates against pipeline IR at startup. `log :stdout` (and the other built-in destinations) emits run-level events through the existing `buildRunLogEvent` plumbing — same `<snake_class>.<method>.<event>` vocabulary gens use (`complete`, `failed`, with `reason: budget_exceeded | validation_failed | error`).
- **`cambium new pipeline <Name>` scaffolder (RED-381 Phase G).** Emits `app/pipelines/<snake>.pipeline.rb` with input + step + fan_out/branch_on/output examples commented out, plus a vitest stub under `tests/`. `cambium lint` walks `app/pipelines/` checking basename regex, Pipeline inheritance, 1:1 stance, input schema resolution. VS Code extension `cambium-syntax@0.7.0`: `.pipeline.rb` registered, syntax highlighting + LSP hover for `Pipeline` / `step` / `fan_out` / `branch_on` / `input` / `output` / `bind_defaults` / `bind`, five new snippets (`pipeline`, `pstep`, `fanout`, `branchon`, `poutput`), `app/pipelines/` scanned for `gen:` kwarg completions.
- **`grounded_in :source, from: "<path>"` kwarg (RED-383 v1).** Loads a file at compile time and bakes it into `ir.context[<source>]`. `.pdf` → `base64_pdf` envelope (consumed by Anthropic native PDF blocks + the extracted-text fallback for other providers). `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` → `base64_image` envelope. Everything else → plain string. Path resolution: relative paths anchor to the gen file's directory (not cwd); absolute paths pass through. CLI `--arg` still wins at runtime — `from:` is a default, not a lock. Closes the canonical "ground in this PDF on disk" friction without forcing the operator to thread the file through `--arg` every invocation. URL fetching + magic-byte sniffing defer to RED-383 v2.
- **Cambium CI Review pipeline (real POC, not a fixture).** `packages/cambium/app/pipelines/cambium_ci_review.pipeline.rb` — a real two-stage pipeline that reviews Cambium PRs. Stage 1 (`CambiumDiffAnalyzer`) classifies the diff into structured Cambium-flavored labels: touched subsystems (ruby_dsl, ts_runner, tool_dispatch, exec_substrate, memory, ...), risk categories (new_dsl_primitive, new_ir_field, tool_dispatch_change, wire_format_change, ...), magnitude, key excerpts. Stage 2 (`CambiumPrReviewer`) reasons from the structured analysis (it doesn't re-read the diff) and produces a typed `CambiumCiReview` with severity-tagged concerns + verdict. The reviewer's system prompt is Cambium-aware — it references CLAUDE.md's "Non-obvious invariants" clusters explicitly, knows when to flag missing-doc-on-new-primitive as `blocking`, knows the `:native` exec substrate is a fig-leaf, knows the v1 wire format is locked. Schemas in `src/contracts.ts`; gens + system prompts ship alongside.
- **Forgejo Actions workflow for CI Review (`.forgejo/workflows/ci-review.yml`).** Wires the `cambium_ci_review` pipeline into every PR: checks out PR head, computes diff against base, runs the pipeline, posts the typed review (verdict + grouped concerns) as a PR comment via the Forgejo/GitHub-compatible `/repos/{owner}/{repo}/issues/{N}/comments` API. The pipeline's gens use `model :default` (= `omlx:Qwen3.5-27B-4bit` per `app/config/models.rb`), so the workflow needs a LAN-reachable oMLX endpoint — configured via the `CAMBIUM_OMLX_BASEURL` repo secret. Pre-run probe of `/v1/models`; falls back to `--mock` if the secret is unset or the endpoint is unreachable, so the workflow stays green on first install. Lives under `.forgejo/workflows/` rather than `.github/workflows/` because real-LLM mode depends on local-network inference; public GitHub runners can't reach the LAN.

### Fixed

- **Pipeline run from external `[package]` workspaces (RED-381 followup).** Three drifts surfaced building PixelWorlds: (a) sub-gen `compile.rb` lookup was anchored to `process.cwd()` — broke from any workspace outside the Cambium repo. Fix: `compileRb` option threaded through the dispatch context; CLI + serve pass their resolved paths; library callers without an explicit path get a best-effort `resolveDefaultCompileRb()` that tries `createRequire('@redwood-labs/cambium/package.json')` first, then falls back to an in-tree dev resolution. (b) App correctors weren't auto-loaded in the pipeline runtime — sub-gens declaring `corrects :foo` for any non-builtin threw "Unknown corrector" at runtime. Fix: load app correctors at the top of `runPipelineFromIr`, pass through to every sub-gen's `runGen` call. (c) `CAMBIUM_OMLX_BASEURL` with a trailing `/v1` (the form LM Studio docs) produced doubled-path 404s. Fix: `normalizeOmlxBaseUrl()` strips trailing `/v1` with a one-time stderr nudge.
- **Multi-bind pipeline prompt rendering (RED-382).** The pipeline runner spread bindings into `subIr.context` cleanly, but the prompt-build path silently dropped them — only `*_enriched` keys (the enrich primitive's convention) made it into the prompt, and `getGroundingDocument()` returned `''` for any non-string value. Symptom: SceneComposer hallucinating prompts unrelated to its rolled axes. Fix: (a) `getGroundingDocument` now JSON-serializes non-string values (typed envelopes preserved for the documents path); (b) new `appendNonPrimaryContextSections` helper iterates every key in `ir.context`, emitting each as a `<KEY>:` block. `*_enriched` keys keep their `<KEY>_ANALYSIS:` legacy label for back-compat.
- **`guardedFetch` hang on multi-MB responses (RED-137 followup).** The undici dispatcher was being closed in `finally` BEFORE callers could consume the response body — orphaned the stream silently. Small responses (~KB) survived via TCP receive buffer; multi-MB responses (PDF / image / multi-MB JSON downloads) hit a closed dispatcher mid-read and the returned Promise never resolved nor kept the event loop alive. Symptom: host process exits cleanly with "Detected unsettled top-level await" (Node 23+) or hangs indefinitely (Node 22). Fix: fully read the body via `arrayBuffer()` before the `finally` closes the dispatcher; return a fresh Response with the buffered bytes. Discovered via PixelWorlds's ComfyUI render action downloading a 1.4 MB PNG through `ctx.fetch`.
- **Two pre-existing schema-validation test failures (RED-373 fallout).** Temp-dir fixture tests in `compile_schema_validation.test.ts` and `cambium_compile_subcommand.test.ts` used flat layouts that didn't trigger post-RED-373 source-anchored schema discovery. Fix: write a sibling `schemas.ts` (engine-sibling discovery) into the temp dir so the validation arm runs honestly.

### Changed

- **`grounded_in` strict pre-flight check (migration note).** A gen declaring `grounded_in :source` that's invoked with missing/empty `ir.context.<source>` now hard-fails at `runGen` entry with a `GroundingMissing` trace step — BEFORE any LLM dispatch. Pre-0.5.0, `getGroundingDocument` returned `''` silently and the model produced output hallucinated from the schema shape alone (with `require_citations: false`) or failed at the citation-verification step (with `require_citations: true`). The new behavior is strictly better: empty context never reaches the model. **What might break:** gens that previously relied on the silent-empty behavior to "skip" grounding at runtime. The fix is to either (a) provide a real value (recommended — `from:` makes this one line now) or (b) drop the `grounded_in` declaration. Mock-mode (`CAMBIUM_ALLOW_MOCK=1`) skips the pre-flight check so framework tests with empty mock contexts continue to work.
- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.5.0`. No CLI surface removals.
- **VS Code extension `cambium-syntax`** bumps to `0.7.0` (independent versioning).
- `CLAUDE.md` "Key concepts" gains a `Pipeline` bullet; project-structure tree adds `app/pipelines/`; `cambium new ... |pipeline` added to CLI commands; new "Pipeline orchestration runtime" non-obvious-invariants cluster (9 bullets) with a naming-note callout disambiguating from the pre-existing "Pipeline structure + compile-time enforcement" cluster (which is about gen-side correctors/repair, not the orchestration-layer `Pipeline` primitive).
- `docs/GenDSL Docs/` adds [`N - Orchestration Layer.md`](docs/GenDSL%20Docs/N%20-%20Orchestration%20Layer.md). `C - IR` extends with a "Pipeline IR fields" section; `C - Trace` gains five new step-type rows; `C - Serve Mode` updates the lifecycle for the kind-based dispatch; `P - Memory` adds `:pipeline_run` to the scope list; `P - cron` / `P - log` / `P - grounded_in` gain cross-refs + `from:` documentation.
- `README.md` Key features gains an "Orchestration layer" bullet.

### Security

- **Pipeline `method:` shell-injection guard (RED-381 followup).** The three `execSync` sites in `pipeline.ts` that spawn `ruby compile.rb` previously interpolated the `method` value without quoting or regex validation. The IR is `any`-typed and accepted from external callers via `runPipelineFromIr({ ir })`; a hand-crafted IR with `method: "analyze; rm -rf"` would have executed arbitrary shell. Fix: `assertSafeMethodName` enforces `/^[a-z][a-z0-9_]*$/` (same regex pack names, memory pools, app correctors, grounded_in sources, and model aliases already use) before every `execSync`. Belt-and-suspenders: `method` is also quoted at each shell-string interpolation site.
- **`grounded_in` strict pre-flight as a hardening measure.** See "Changed" above — the previous silent-empty behavior was a latent footgun (gens that thought they were grounded weren't); the new hard-fail is observably stricter but eliminates the silent-hallucination class.

## [0.4.1] — 2026-05-13

Patch release. Three urgent fixes for downstream users on npm-installed Cambium + modern Ruby, surfaced an hour after 0.4.0 shipped:

### Fixed

- **`cambium serve` can now locate `compile.rb` when installed from npm (RED-376).** The default compile-script path was computed as 4-levels-up from `packages/cambium-runner/{src,dist}/serve/serve.{ts,js}` — the workspace root in the monorepo, but `node_modules/` once installed. First `/v1/run` request blew up with ENOENT on `node_modules/ruby/cambium/compile.rb`. Fix layered three ways (highest precedence first): new `compileRb` option on `RunServeOptions`, `CAMBIUM_COMPILE_RB` env-var escape hatch, monorepo-relative fallback for in-tree tests. `cli/serve.mjs` computes the path relative to `import.meta.url` and threads it through. The CLI package definitionally ships its own `ruby/` directory next to `cli/`, so the resolution works regardless of where npm hoists. Mirrors `cli/cambium.mjs`'s pattern; see [`C - Serve Mode.md`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md) § "Locating `compile.rb`".
- **`generate` DSL works on Ruby 3.0+ (RED-377).** `ruby/cambium/runtime.rb` used `Proc.new` (no explicit block arg) to capture the calling block — implicit-block-capture was Ruby-2.7-deprecated and Ruby-3.0-removed. Alpine ships Ruby 3.4; any `cambium serve` running in a modern container hit `ArgumentError: tried to create Proc object without a block` on the first gen using block-form `generate`. Switched to the standard `&block` parameter pattern already used by `enrich` and `on` in the same file. No behavior change on Ruby 2.x; restores compilation on Ruby 3.x. Local-dev Ruby 2.6.10 masked the bug; CI doesn't yet exercise Ruby 3.x (filed as follow-up).
- **`--mock` now honors `mode :agentic` (RED-375).** The single-shot text path (`generateText`) gated on `CAMBIUM_ALLOW_MOCK` before any provider fetch; the agentic tool-calling path (`generateWithTools`) had no such gate and went straight to the provider, so `cambium run --mock` on any `mode :agentic` gen either hit a real LLM (Ollama/oMLX if reachable) or hard-errored on missing `ANTHROPIC_API_KEY`. `--mock` was a lie there. Added the same gate at the top of `generateWithTools`: return one turn of `mockGenerate(...)` with an empty `tool_calls` array, which terminates the agentic loop after one turn with the mock content as the final answer. Same semantic as the non-agentic mock path. `runner_mock_smoke.test.ts` now covers `data_analyst` (the first in-tree `mode :agentic` gen) under `--mock`. Extends the parallel-gap note in [`N - App Mode vs Engine Mode (RED-220)`](docs/GenDSL%20Docs/N%20-%20App%20Mode%20vs%20Engine%20Mode%20%28RED-220%29.md) item 4.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.4.1`. No CLI surface changes; new `compileRb` option on `RunServeOptions` is additive.

## [0.4.0] — 2026-05-13

Minor release. Headline: **serve mode + first-party Python client**. Cambium can now run as a long-lived HTTP server (`cambium serve`) hosting every gen in a workspace, and a `pip install cambium-client` Python package talks to it natively with one sync+async `CambiumClient` API. The migration target — a FastAPI service swapping its subprocess wrapper for the client with one import change and calling warm Cambium on the request path — is now real.

Also lands three smaller follow-ups: profile-driven model selection in `models.rb`, file-based enrichment for PDFs, and a compile-time contracts-search fix that surfaced during the PyPI publish-validation smoke.

### Added

- **`cambium serve --workspace <path> --bind <uri>` (RED-360).** Long-lived HTTP server hosting every gen in a workspace. The transport for non-Node hosts (FastAPI, Django, Go, Elixir, anything that speaks HTTP + JSON). v1 wire format locked: `POST /v1/run`, `GET /v1/healthz`. Closed 11-kind `error.kind` enum (`unknown_gen`, `unknown_method`, `input_invalid`, `validation_failed`, `budget_exhausted`, `tool_dispatch_failed`, `runner_error`, `timeout`, `overloaded`, `booting`, `not_found`) with HTTP status mapping. `run_id` always present on the response (`null` on pre-dispatch errors). Three operational flags: `--max-inflight` (overloaded 503), `--run-timeout` (timeout 504), `--shutdown-timeout` (bounded drain with force-close on deadline). `--allow-remote` opt-in for non-loopback tcp:// binds; loopback-only by default. Bind URIs: `tcp://`, `unix://`, `pipe://` (Windows named pipes). Boot-time pre-compile of every (gen × method) means the server fails fast if any gen has a Ruby-side syntax error — half-loaded servers are not a state v1 allows. Full design at [`docs/GenDSL Docs/C - Serve Mode.md`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md).
- **`cambium-client` Python package (RED-361, published to PyPI as `cambium-client@0.1.0`).** First-party client for `cambium serve`. Sync + async on one `CambiumClient` (`run`, `run_async`, `healthz`, `healthz_async`), shared `httpx` connection pool, context-manager protocol both ways. One exception subclass per wire `error.kind` (`UnknownGenError`, `CambiumTimeoutError`, etc.). Connection failures re-raised as `CambiumConnectionError`. Back-compat aliases (`CambiumNotFoundError = CambiumConnectionError`, `CambiumRunError = RunnerError`) preserve existing subprocess-wrapper naming. TCP + UDS transports in v1; `pipe://` raises `NotImplementedError` (v1.1 follow-up). `py.typed` PEP-561 marker so mypy/pyright work for callers. `pre_publish_check.py` script gates publishing on a clean wheel install in a fresh venv.
- **`compile.rb` polymorphic on `--method` (RED-360).** Bare-mode (no `--method`) emits a `{method → IR}` map for every public user method on the GenModel; `--method X` still emits a single IR. `cambium compile <file>` defaults to the bare form. Existing `cambium run` (always passes `--method`) and engine-mode build steps unchanged. This is what serve-mode boot consumes — one Ruby invocation per gen catalogs every (method, IR) pair.
- **`profile :dev / :prod` blocks in `app/config/models.rb` (RED-326).** Workspace aliases (RED-237) now pivot by environment. `profile :dev do default "omlx:..." end` + `profile :prod do default "anthropic:..." end` swap the model literal based on the active profile. Resolution priority: `--profile <name>` CLI flag → `CAMBIUM_PROFILE` env var → profile literally named `:dev` (implicit default) → first declared profile. Aliases outside any profile are globals shared across all profiles. Back-compat: workspaces with no `profile` blocks behave exactly as RED-237. New `--profile <name>` flag on `cambium run` / `cambium compile`. Error-message context now names the active profile + declared profiles list. Full design at [`docs/GenDSL Docs/N - Model Identifiers.md`](docs/GenDSL%20Docs/N%20-%20Model%20Identifiers.md) under "Profile-driven model selection".
- **File-based `enrich` accepting `base64_pdf` envelopes (RED-327).** Closes the asymmetry between `grounded_in` and `enrich`: `grounded_in` has read PDFs natively since RED-323, but `enrich` was passing the raw envelope to the sub-agent. Now the runner routes `base64_pdf` context values through the same `extractDocuments` plumbing `grounded_in` uses — the sub-agent receives `ctx.input` as extracted PDF text. `base64_image` envelopes surface as `EnrichSkipped` with a clear "no extractable text" reason (vision-model sub-agent integration is a documented follow-up). Plain strings/dicts/lists pass through unchanged. New `resolveEnrichmentInput` helper in `enrich.ts` is the dispatch decision; `isDocumentEntry` exported from `documents.ts` so envelope detection lives in one place.

### Fixed

- **`compile.rb` schema validator no longer picks the wrong workspace's contracts.ts via a cwd-relative fallback (RED-373).** Two stacked bugs: the workspace-dir candidate was one level too shallow (`<workspace>/app/src/contracts.ts` instead of `<workspace>/src/contracts.ts`), AND a cwd-relative `packages/cambium/src/contracts.ts` fallback could match the WRONG workspace's contracts when an operator ran `cambium serve --workspace <other>` from a Cambium repo cwd. Fix: walk TWO levels up to the real workspace root, drop the cwd-relative fallback entirely (post-0.3.3 the TS runtime walks up from `ir.entry.source` for contracts, so compile-time validation can rely on the same source-anchored discovery). Surfaced during the RED-361 PyPI publish-validation smoke test (2026-05-13). Benign in the common operator flows — bites only the development scenario where the operator runs the server against an external workspace from their cambium checkout.

### Changed

- **`@redwood-labs/cambium`** and **`@redwood-labs/cambium-runner`** bump to `0.4.0`. No CLI surface removals; the only new commands are `cambium serve` (additive) and `cambium compile` without `--method` (additive — `--method` still works exactly as before).
- `CLAUDE.md` CLI commands list updated for `cambium serve` and the new `cambium compile [--method]` shape. Project-structure tree now includes `packages/cambium-runner/src/serve/` and `packages/cambium-client-python/`.
- `README.md` Key features lists serve mode + links to `cambium-client`.
- `docs/GenDSL Docs/` adds [`C - Serve Mode.md`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md), extends `P - enrich.md` with the document-envelope section, and `N - Model Identifiers.md` with the profile-selection section. Docs map index updated.

### Security

- **Serve mode boundary `parseMemoryKeys` validation (defense in depth).** Wire-format `memory_keys` is validated at the HTTP handler in addition to the existing deep-in-`runGen` `validateSafeSegment` check, so a future refactor of the runGen → runGenFromIr call path can't silently drop the path-traversal protection.
- **`unix://` bind URIs reject `..` segments.** Node's `server.listen(path)` silently normalises `/tmp/../etc/foo` to `/etc/foo` before binding; the bind URI parser rejects any `..` segment so a wrapper script constructing `--bind` URIs from user input can't surprise the operator.
- **Python client subprocess-fixture UDS path enforces macOS `sun_path` limit.** Defensive against an unusually long `TMPDIR` — raises a clear length-exceeded message rather than letting `bind()` fail with an obscure OSError.

## [0.3.3] — 2026-05-07

Patch release. Closes the cross-environment debugging story for downstream
adopters running Cambium in containers, CI, and across machines. Five
small, complementary changes: two fixes to path resolution, one
operator-facing diagnostic, one DX export, and one security guard caught
during the security review of the diagnostic.

### Fixed

- **`Genfile.toml [types].contracts` is now resolved relative to the
  gen's package, not the runner's cwd.** Pre-0.3.3, `runGenFromIr`
  walked up from `process.cwd()` looking for `Genfile.toml`. When a
  Cambium app ran with cwd inside a *different* Cambium workspace
  (host running a downstream tool against another project; container
  with a mismatched cwd), it loaded the wrong workspace's contracts —
  resolving `returnSchemaId` against unrelated schemas, with confusing
  "schema not found" errors. The Genfile lookup now walks up from
  `ir.entry.source` first (the gen file is the source of truth), with
  cwd as a fallback. Mirrors the engine-mode (RED-287) and
  ModelAliases (RED-237) stance — the gen's package is authoritative,
  not the host's cwd. New `findGenfileDir(sourcePath)` in
  `packages/cambium-runner/src/genfile.ts`.
- **Engine detection has a cwd-fallback for cross-env IRs (RED-353).**
  When `ir.entry.source` is an absolute host path that doesn't exist
  at run time (canonical case: IR compiled on the host with
  `/Users/Steve/...` baked in by automated tooling, run in a container
  with a different filesystem layout), `resolveEngineDir(entry.source)`
  returns null and the runner would silently fall through to app
  mode — misrouting engine schema loading and producing a confusing
  "schema not found" error. New `findEngineDirFromCwd(cwd)` in
  `engine-root.ts` is the fallback: walk up from cwd looking for the
  same `cambium.engine.json` sentinel. `runGenFromIr` invokes it only
  when source-based detection fails AND `entry.source` is unreachable
  on disk — source-anchored detection still wins when the path
  exists, so the explicit "engine discovery follows source not cwd"
  property of `engine_mode_e2e` (run-from-anywhere) is preserved
  verbatim. Operator contract: at run time, cwd is the engine dir or
  an ancestor of it. Resolved `engineDir` is also passed explicitly
  to `runGen` so the inner re-detection doesn't undo the cwd
  resolution.

### Added

- **`[cambium] run <id> dir=<abs> trace=<abs>` emitted to stderr at
  run start (RED-330).** The runner used to print the trace path
  *after* the run completed — a run that aborted before completion
  (early validation failure, OOM, killed mid-call) left the operator
  with stderr only and no audit trail. `runGenFromIr` now emits the
  run dir and trace path before any heavy work (memory planning,
  document extraction, schema validation, LLM calls). Every exit
  path leaves a discoverable artifact location on stderr; downstream
  tooling (loop drivers, CI scripts) can grep `[cambium] run` to
  find traces without scanning the FS. Format is single-line
  key=value so it stays parseable. Eager mkdir of the run dir; if
  mkdir fails (FS error, permissions), the line carries a
  `(not yet created)` suffix.
- **`IR` type re-exported from `@redwood-labs/cambium-runner` (RED-354).**
  Consumers can now write `import type { IR } from '@redwood-labs/cambium-runner'`
  instead of `as any`-casting at every call site. The type is still
  a loose alias (`type IR = any`) — sharpening to a structured
  interface is a follow-up; the export gives consumers a stable
  name to import today.
- **`runId?` optional field on `RunGenOptions`.** Library callers
  that want the emitted run dir / trace path to match a value they
  generated can pin the run id. Auto-generated otherwise.

### Security

- **Path-traversal guard on `opts.runId`.** Caught during security
  review of RED-330: `opts.runId` joins into `runs/<runId>/...` for
  the eager mkdir + stderr emit and into per-step trace refs without
  any validation. `node:path.join` silently normalizes `..`, so a
  hostile library caller passing `runId: '../../etc/foo'` would
  resolve outside the intended runs root. The runner now reuses the
  same `SAFE_VALUE_RE` (`/^[a-zA-Z0-9_\-]+$/`, 128-char max) and
  `validateSafeSegment` helper as `--memory-key` and
  `CAMBIUM_SESSION_ID` (RED-215 phase 3). Auto-generated runIds
  (`run_<UTC>_<rand>`) trivially pass; legitimate library callers
  are unaffected. `validateSafeSegment` was promoted from
  module-private to exported so the regex lives in one place.

### Changed

- **`@redwood-labs/cambium`** bumps runner dep pin from `0.3.2` →
  `0.3.3`. No CLI surface changes.
- `CLAUDE.md` documents two new invariants in the "Code-gen +
  path-traversal guards" cluster: the source-anchored Genfile picker
  vs. the validator, and the engine cwd-fallback contract.
- `docs/GenDSL Docs/N - App Mode vs Engine Mode (RED-220).md` item 6
  (engine-mode runtime catch-up) documents the cross-env fallback
  and the operator contract.
- `packages/cambium-runner/README.md` options block lists the new
  `runId` field; type re-export list includes `IR`.

### Closes

- **RED-353** — IR compiler emits absolute paths, breaking
  cross-environment portability. Fixed at the runner side via the
  cwd-fallback (deliberate scope: keep the IR shape stable; the
  in-process "run from anywhere" pattern in engine_mode_e2e
  required preserving the absolute-path-when-reachable behavior).
- **RED-330** — Trace path discoverability for early-abort runs.
- **RED-354** — Runner package doesn't export IR type.

### Upgrade from 0.3.2

```bash
npm install -g @redwood-labs/cambium@latest
# or for local project deps:
npm install @redwood-labs/cambium@latest
```

No breaking changes for the common case (in-tree gens where cwd is
the workspace root). Two new invariants worth knowing:

- **Library callers passing `runGen({ runId: '...' })`** must use
  safe path-segment characters (`/^[a-zA-Z0-9_\-]+$/`, max 128 chars).
  Auto-generated runIds trivially pass; only callers that synthesize
  their own runId need to be aware.
- **Cross-env deployments** (Docker, CI, peer-machine): when running
  an IR whose `entry.source` doesn't exist on the executing machine,
  cwd at run time should be the engine dir or workspace root. The
  cwd-fallback walks up from there to find `cambium.engine.json` or
  `Genfile.toml`. Same-host runs (cambium run + execute in one
  process) are unaffected.

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
