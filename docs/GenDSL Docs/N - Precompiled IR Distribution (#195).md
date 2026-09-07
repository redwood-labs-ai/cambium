## Note: Precompiled IR Distribution

**Doc ID:** gen-dsl/note/precompiled-ir-distribution
**Status:** Shipped — #195
**Last edited:** 2026-09-03

---

## Purpose

`runGenFromIr` was already Ruby-free — it consumes IR JSON with no Ruby anywhere in the call path. Engine mode already materializes `<gen>.ir.json` at build time. But the two operational entry points still required Ruby on the *target* machine: `cambium serve` spawned `ruby compile.rb` once per gen at boot, and `cambium run` always compiled from `.cmb.rb`.

This note is the plan of record for closing that gap: "ship compiled IR; Ruby is a build-time dependency" — the property every embedded/OS/appliance/container-slim deployment needs — reachable through the CLI, not just the library.

**Policy, stated once:** authoring a gen needs Ruby. Consuming one — running a `.ir.json` artifact someone else compiled — needs only Node. This note is entirely about the consuming side.

---

## Why Ruby is build-time only

Cambium's Ruby surface compiles a DSL to a JSON plan; nothing about *executing* that plan is Ruby-shaped. Requiring Ruby on every machine that runs a gen — a Docker base image, a serverless function, a CI runner, an embedded device — is friction with no corresponding value once the IR exists. The DSL's job ends at `compile.rb`'s stdout.

---

## Producer ↔ consumer symmetry

Three producers already existed before this work; #195 adds the two consumers that complete the pairs.

| Producer | Artifact shape | Consumer (new in #195) |
| --- | --- | --- |
| `cambium compile --write` (app mode) | `<gen>.ir.json`, sibling of the `.cmb.rb` | `cambium serve --precompiled` |
| `cambium compile --out-dir <dir>` (app mode) | `<dir>/<basename>.ir.json`, flat by basename | `cambium serve --ir-dir <dir>` |
| Engine mode (`cambium compile`, unconditional) | `<engineDir>/<gen>.ir.json`, sibling | `cambium run --ir <path>` (any of the three shapes above) |

All three producers emit **bare-mode** compiler output (no `--method`) — a `{ method → IR }` map, one Ruby invocation per gen covering every public method. `cambium run --ir` also accepts a **single-IR** artifact (`compile <file> --method m -o out.ir.json`), keyed by its own `entry.method`.

There is no new producer in this work and no new artifact shape — `ir-artifact.ts` (below) reads exactly the bytes the existing producers already write.

---

## The shipped-workspace layout contract

A workspace built to run without Ruby looks like:

```
my-app/
├── Genfile.toml              # [exports.gens] names the gens; unchanged from dev
├── app/
│   ├── gens/
│   │   └── resume_parser.ir.json    # OR: dist/ir/resume_parser.ir.json (--ir-dir)
│   ├── correctors/            # optional — runtime plugin dirs are unaffected
│   ├── tools/
│   └── policies/
└── src/
    └── contracts.ts           # only if any gen uses returns :Symbol
```

`resume_parser.cmb.rb` **need not be present**. The Genfile still names it (`ResumeParser = "app/gens/resume_parser.cmb.rb"`) — the catalog names gens, not files — but nothing reads that file in precompiled mode. Everything under `app/<type>/` that the runner discovers at run time (correctors, tools, actions, providers, log sinks) ships exactly as it does today; discovery is unaffected by whether the paired `.cmb.rb` sources exist.

**No hot reload.** Operators bounce the process to pick up a new artifact — matches serve v1's existing "no `--watch`" stance.

**No freshness check.** There's no mtime comparison between a `.cmb.rb` and its artifact; a fresh git checkout or package install stamps files in an order that makes mtime meaningless, and a false "stale" failure at boot is worse than trusting the operator's build step. `cambium serve` logs `[cambium serve] precompiled: <n> gen(s) from <where>` at boot so the mode is visible in process output. A content-digest staleness check is a real idea for later — it needs an additive IR field (a hash of compile inputs) and a corpus regeneration, both bigger than this slice.

---

## What is compile-time vs run-time: the closed-IR rule

Almost everything in an IR is resolved at compile time already — system prompt inlined, policies/packs/pools/log profiles/model aliases/the repair slot resolved, `from:` content baked into `context`. Three sites are the exception; each still shells out to Ruby **at request time**:

| Site | Why it needs Ruby at run time |
| --- | --- |
| Pipelines (`kind: "Pipeline"`) | Sub-gen IRs are compiled on demand at each step's dispatch (`pipeline.ts`). |
| `enrich` | The enrichment sub-agent's IR is compiled via a `ruby compile.rb` spawn (`enrich.ts`). |
| Retro memory-write agents (`policies.memory_write_via`) | The retro agent re-spawns the CLI, which recompiles. |

A precompiled artifact must have **none** of these — `ir-artifact.ts`'s `runtimeCompileSites(ir)` returns the (possibly empty) list, and both consumers refuse to load an IR where it's non-empty, naming the gen, the site, and that it needs Ruby at run time. Refusing at load, not at first dispatch, keeps "no Ruby on PATH" a **whole-process** property: half of a precompiled workspace working and half failing at request time is exactly the state serve mode has never allowed (see [[C - Serve Mode]] § Boot fail-fast), and the same stance now extends to `cambium run --ir`.

`[exports.pipelines]` entries are refused outright at catalog load in precompiled serve mode, before any path or file-existence check — a Pipeline IR needs Ruby per sub-gen regardless of what its own top-level fields look like.

**Symbol-form gens** (`returns :Symbol`) are a related but distinct concern: they don't need Ruby at run time, but they do need a contracts module injected. A precompiled workspace that never declares `[types].contracts` would otherwise fail on the gen's first request; both consumers check this at boot/startup instead — the "Precompiled boot" section of [[C - Serve Mode]] for `cambium serve`, and the "`cambium run --ir` semantics" section below for `cambium run`.

---

## `cambium run --ir` semantics

```bash
cambium run --ir <file.ir.json> [--method <method>] [--arg <path>|-] \
  [--trace <path>] [--out <path>] [--mock] \
  [--memory-key <name>=<value> ...] [--session-id <id>] [--fired-by <id>]
```

- `--ir` is a flag, not a positional replacement — a positional `.cmb.rb` together with `--ir` is a usage error (exit 2). This keeps "the first positional argument is the gen source" true forever for the compile-then-run path.
- `--method` is required for a multi-method (map) artifact — the error lists the available methods. Optional for a single-IR artifact, and must equal the artifact's own `entry.method` if given.
- `--profile` is refused with `--ir` (exit 2): profiles resolve at compile time (RED-326); there is nothing left to select at run time. Recompile with `--profile` (or `CAMBIUM_PROFILE`) instead.
- `--arg`, omitted, keeps the artifact's baked-in context (the RED-383 `from:` default) — the same default the compile-then-run path uses for a gen (#220 closed the divergence this note used to describe here). `--arg <path>` / `--arg -` override it via the same `injectContextInput` helper `cambium serve` uses per request — one definition of "override the one context key," shared by both consumers. One edge case still differs, and is not parity: `--arg ''` is treated as omitted on the compile-then-run path (deliberately — tightening that predicate would forward `--arg ''` to `compile.rb`'s `File.read('')` and raise `Errno::ENOENT`), but here the gate is `arg !== null`, so `--arg ''` takes the override branch and this path's own `readFileSync('')` raises, exiting 1. Don't read this section as promising the two agree on every input.
- Reading, validating, and refusing a bad artifact all happen before any run directory is created — exit 1, not a corrupted-looking half-written `runs/<id>/`.

---

## Anchoring: the artifact's own location, not `entry.source`

`ir.entry.source` is the path Ruby was invoked with at compile time — a build-machine detail (see [[C - IR (Intermediate Representation)]] § `entry.source` portability). A shipped artifact's own on-disk location is the only anchor that's true on every machine it might run on.

Both consumers compute discovery roots from the **gen's own location**, explicitly, and pass them into `runGenFromIr` — never from `cwd`, never from `entry.source`:

- `cambium serve` (precompiled mode): **per gen**, the nearest `Genfile.toml` above the gen's declared source path (`[exports.gens]`'s value, which need not exist on disk — its directory chain does), falling back to `--workspace` when none sits between. This is exactly what compile-at-boot resolves by walking up from `entry.source`, so a workspace root that exports gens from a member package with its own `[types]` (the `[workspace]` + per-package `Genfile.toml` layout) anchors each gen on its member, not on the root. Anchoring every gen on `--workspace` was the first cut and the audit caught it (AUD-001): a nested gen's schema resolved against the root's contracts and 500'd where compile-at-boot returned 200.
- `cambium run --ir <path>`: `resolveArtifactAnchors(path)` (exported from the runner) yields `engineDir` (sentinel walk-up from the artifact's directory), `appRoot` (nearest `Genfile.toml` above the artifact) and, in app mode, whether that workspace declares `[types].contracts` — walked from the artifact's own location, never from `cwd` and never from `entry.source`. The walk-up helpers behind it are package-private; the anchor function is the promised surface.

`runGenFromIr` was extended to make this explicit anchoring authoritative: `opts.appRoot` now wins as the tier-1 workspace for **contracts and app-corrector discovery** (not just tool/action/provider/log-sink discovery, which is where it already won) whenever `<appRoot>/Genfile.toml` exists, and a new `opts.engineDir` option lets a caller state the engine folder outright instead of relying on the source-then-cwd fallback. See [[N - App Mode vs Engine Mode (RED-220)]] item 4 for the full operator-contract text — this note just states why it mattered for #195: without it, a shipped artifact whose `entry.source` happens to be a *relative* path could resolve into whatever workspace the operator's shell happened to be sitting in, silently loading the wrong correctors.

Every pre-existing caller (`cambium run`, pipeline sub-gen dispatch) is unaffected — `opts.appRoot`/`opts.engineDir` are `undefined` unless explicitly passed, so the new tier-1 check is a no-op and compile-at-boot / compile-then-run stay byte-identical.

---

## One artifact reader

`ir-artifact.ts` (`packages/cambium-runner/src/ir-artifact.ts`) is the single validator both consumers use, rather than each parsing bytes off disk ad hoc:

- `parseIrArtifact(text, label)` — detects single-IR vs `{ method → IR }` map shape, validates every IR it finds.
- `assertGenIr(ir, label)` — version gate (`SUPPORTED_IR_VERSIONS`), structural checks (`entry`, `steps`, `context`, the `returnSchema`/`returnSchemaId` xor), the closed-IR rule above, and two guards on fields that reach a sink: `returnSchemaId` must be an identifier and not a reserved property name (`__proto__` on a plain-object contracts module resolves to `Object.prototype`, which AJV compiles into an accept-everything validator; the runner's lookup is own-property-only as well), and every `policies.memory[]` decl's `name` / `scope` must match `/^[a-zA-Z0-9_\-]{1,128}$/` (they become directory names under `runs/memory/`; the bucket-path resolver enforces the same guard for compiled IR).
- `readIrArtifactFile(irPath)` — the one read path (serve boot and `run --ir`): refuses artifacts over `MAX_IR_ARTIFACT_BYTES` (50 MB, the same bound compile-at-boot applies to `compile.rb` output), then `parseIrArtifact`.
- `runtimeCompileSites(ir)`, `needsContracts(ir)`, `injectContextInput(ir, input)` — the individual predicates/mutators the two boot-time checks and the per-call context override are built from.

Not all of that is a *promised* surface. `@redwood-labs/cambium-runner` re-exports only what a caller outside the package needs: `readIrArtifactFile`, `resolveArtifactAnchors`, `needsContracts`, `injectContextInput`, `IrArtifactError`, `SUPPORTED_IR_VERSIONS`, `MAX_IR_ARTIFACT_BYTES`, and the two return types (`ParsedIrArtifact`, `ArtifactAnchors`) — the set `cli/cambium.mjs` calls across the package boundary. `parseIrArtifact` / `assertGenIr` / `runtimeCompileSites` stay module-internal: `readIrArtifactFile` already runs them on the caller's behalf, and under [`COMPATIBILITY.md`](../../COMPATIBILITY.md) § Runner library API a named export is frozen for good — the same reasoning that keeps the walk-up helpers behind `resolveArtifactAnchors` package-private.

Deliberately **not** a full JSON-Schema validation of the IR — the exported `IR` TypeScript type is an opaque, phantom-branded handle (Road to 1.0, Gate 1); a schema would become a second, drifting definition of its shape. The structural checks above are the minimum a caller needs before trusting the bytes.

---

## `cli/lint.mjs` is unaffected

`cambium lint` validates a workspace's *source* layout (declarations, naming, structure) — it's a dev-time tool that runs against `.cmb.rb`/`.pipeline.rb` files and their `app/<type>/` siblings, always with the sources present. A precompiled deployment (sources optionally absent, artifacts only) is never a `cambium lint` target; no change was needed or made here.

## Deferred

- **Precompiled mode for pipelines, `enrich`, and retro memory agents.** Each needs its sub-agent's IR embedded in the artifact set (or resolved from a Ruby-free token projection) — a separable feature, tracked as a follow-up issue. Refusing them for now (rather than letting them fail at first dispatch) keeps this slice's acceptance bar intact.
- **Artifact freshness digest.** A content hash of compile inputs, stored in the IR, checked at boot against the `.cmb.rb`'s current hash. Needs an additive IR field and a golden-corpus regeneration.
- **Hot reload of `.ir.json` artifacts.** Matches serve v1's existing no-hot-reload stance for `.cmb.rb` sources.
- **`enrich.ts`'s cwd-relative Ruby spawn.** A pre-existing bug (not introduced here, not fixed here): `enrich.ts` shells `ruby ruby/cambium/compile.rb` relative to cwd rather than an absolute, resolved path. Filed separately.
- ~~**The compiled path's omitted-`--arg` bug.**~~ *(Resolved by #220.)* `cambium run` without `--ir` no longer defaults an omitted `--arg` to `'{}'` piped over stdin — it forwards the omission to `compile.rb`, which applies the same `from:` bake-in this section already described as correct for `cambium run --ir`. See the `#220` entry in `CHANGELOG.md` for the full fix, including the pipeline-side design history (DEC-005 tried, AUD-001 found it leaked, DEC-006 shipped). **#223 then removed DEC-006's substitution outright**: `cambium run <pipeline>` with no `--arg` against a pipeline with declared `input` slots now refuses (exit 2) instead of running on a substituted `'{}'`. See the `#223` entry in `CHANGELOG.md`.

---

## See also

- [[C - Serve Mode]] — `--precompiled` / `--ir-dir` boot, the "Precompiled boot" section, boot fail-fast additions.
- [[C - Runner (TS runtime)]] — `ir-artifact.ts` and the `RunGenFromIrOptions` additions.
- [[C - IR (Intermediate Representation)]] — `entry.source` portability.
- [[N - App Mode vs Engine Mode (RED-220)]] — item 4, the explicit `appRoot`/`engineDir` precedence rule this note relies on.
- `CLAUDE.md` § CLI commands — `cambium run --ir` / `cambium serve --precompiled|--ir-dir` one-line reference (there is no standalone `P -` doc for the base `cambium run`/`cambium compile` commands; they live in CLAUDE.md and `00 - Getting Started`).
- `COMPATIBILITY.md` — why every change in this slice is additive (new flags, new options, one new export set; no `error.kind` addition, no IR field addition).
