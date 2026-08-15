# Cambium Compatibility Promise

**Status:** Published during the 0.9 series — the final window in which breaking
changes land — so the 1.0 surface is settled and reviewable *before* the promise
becomes binding. The promise below **takes effect at Cambium 1.0.** Until 1.0,
Cambium is pre-release: 0.9.x may still break the surfaces named here (each break
lands loud, with a `CHANGELOG.md` migration entry).

Cambium adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
This document defines *what a version number promises* — which surfaces the major
version protects, and what "additive" means for each one.

Cambium is Rails for generation engineering, and this document is written in the
Rails doctrine of **declare less**: every surface promised below is a permanent
maintenance obligation. A surface can be *promoted into* this promise in a later
minor release; a promised surface can never be *demoted out of* it without a major
bump. When in doubt, Cambium promises less and adds later.

---

## What the version number means

| Bump | Meaning |
|------|---------|
| **MAJOR** (`1.x` → `2.0`) | A break to any **promised surface** below — a removed DSL keyword, a changed IR field meaning, a new `error.kind`, a removed CLI verb, a changed library-export signature. |
| **MINOR** (`1.0` → `1.1`) | **Additive only** — new DSL keywords, new IR fields, new trace step types, new CLI verbs/flags, new library exports, new optional keys on an options bag. Existing code keeps working unchanged. |
| **PATCH** (`1.0.0` → `1.0.1`) | Internal-only — bug fixes, performance, docs, and changes to anything on the **Not promised** list. No promised surface moves. |

"Additive only" is the load-bearing phrase. Its precise meaning differs per
surface, so each surface below spells it out.

---

## The promised surfaces

| # | Surface | Promised? | The additive rule |
|---|---------|-----------|-------------------|
| 1 | **Ruby DSL vocabulary** — the `.cmb.rb` / `.pipeline.rb` keywords | ✅ Yes | New keywords / kwargs may be added. No existing keyword is renamed or removed; no kwarg changes meaning. |
| 2 | **IR JSON shape** — the compiled `ir.json` data contract | ✅ Yes | New fields may be added. No existing field is removed or changes meaning. Golden-pinned. |
| — | *IR TypeScript type* — `export type IR` | ❌ **No** | Opaque, phantom-branded handle. Reading a field off it is a compile error *by design*. See below. |
| 3 | **Serve `/v1` wire format** — the HTTP request/response envelopes | ✅ Yes | New endpoints and new *optional* response fields may be added. `error.kind` is a **closed enum**; adding a value is a `/v2` break. |
| 4 | **Trace step vocabulary** — the step `type` values in `trace.json` | ✅ Yes | New step types may be added. No existing type is removed or changes shape. |
| 5 | **Runner library API** — the named exports of `@redwood-labs/cambium-runner` | ✅ Yes | New exports may be added; new *optional* keys may be added to an options bag (e.g. `RunGenOptions`). No export is removed and no existing signature changes. |
| 6 | **CLI surface** — `cambium <verb>` and its flags | ✅ Yes | New verbs and flags may be added. No verb or flag is removed; no flag changes meaning. |

Everything below is the same six surfaces, in detail — what "additive" concretely
permits and forbids, and where the surface is defined in code.

---

### 1. Ruby DSL vocabulary

The `GenModel` and `Pipeline` keywords are the DSL a Cambium author writes. As of
the 0.9 naming sweep (Gate 5) the vocabulary is frozen: one verb/noun grammar,
every regret spent.

- **Additive:** new top-level keywords, new kwargs on an existing keyword, new
  enum values a kwarg accepts.
- **Breaking (MAJOR):** renaming or removing a keyword; renaming a kwarg; changing
  what a kwarg does; narrowing an accepted value set.
- **Defined in:** `ruby/cambium/runtime.rb` (the DSL), `ruby/cambium/compile.rb`
  (the compiler). Documented per primitive under `docs/GenDSL Docs/P - *`.

The 0.9 renames (`write_memory_via` → `writes_memory_via`, `prewarm_cache` →
`prewarm`, `pass_context` → `context`, `branch_on`'s `on` → `match`) were the last
such renames. They land in 0.9 precisely so they do **not** have to happen after
1.0.

### 2. IR JSON shape (and the opaque TypeScript type)

The IR has **two distinct contractual surfaces**, and only one is promised.

**Promised: the JSON shape.** The fields documented in
[`C - IR (Intermediate Representation)`](docs/GenDSL%20Docs/C%20-%20IR%20%28Intermediate%20Representation%29.md)
are a golden-pinned data contract — byte-identical IR JSON is what
`npm run test:golden` protects across the corpus. IR is Arel: a stable,
inspectable plan. Adding an IR field is additive (the same philosophy as Rails'
`schema.rb`); a consumer that reads `ir.model.id` today reads it forever.

- **Additive:** new top-level or nested fields; a new operator kind; a new optional
  key on an operator. A key that is *absent when unset* (so pre-existing IR stays
  byte-identical) is the preferred additive shape — see `model.fallbacks`,
  `returnSchema`, and the `prewarm` operator key for worked examples.
- **Breaking (MAJOR):** removing a field, renaming a field, or changing the meaning
  or type of an existing field.

**Not promised: the exported TypeScript type.** `export type IR` in
`@redwood-labs/cambium-runner` is an **opaque, phantom-branded handle**
(`runner.ts`, Gate 1). Consumers obtain `IR` values via `cambium compile`, by
passing a `JSON.parse(irText)` result to runner functions, or from runner result
objects (`RunGenResult.ir`) — they never read fields off the exported type (field
access on `IR` is a TypeScript compile error). This is deliberate: it keeps the
internal shape free to evolve without breaking consumer code. **If you need to
inspect the plan, read the JSON shape (surface 2), not the TS type.**

### 3. Serve `/v1` wire format

`cambium serve` exposes every gen and pipeline over HTTP. The `/v1` request and
response envelopes are the wire contract between the runner and its clients (e.g.
`cambium-client` for Python).

- **Additive:** new endpoints under a new path; new *optional* fields on a response
  envelope that existing clients can ignore.
- **Breaking (MAJOR / `/v2`):** changing an envelope's required shape, or **adding a
  value to the `error.kind` enum.**
- **Defined in:** `packages/cambium-runner/src/serve/serve.ts` (`type ErrorKind`);
  wire format doc [`C - Serve Mode`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md).

**The `error.kind` closed enum.** Every error response carries a `kind` from a
closed set of **11 values**:

```
unknown_gen · unknown_method · input_invalid · validation_failed ·
budget_exhausted · tool_dispatch_failed · runner_error · timeout ·
overloaded · booting · not_found
```

`error.kind` is closed because typed clients map it **1:1 to an exception class**
(the Python client raises one subclass per kind — `cambium_client/errors.py`). A
client generated against `/v1` therefore has a *complete* mapping. Adding a kind
would mean a `/v1`-generated client silently falls through to the umbrella
`CambiumError` for a case the server now distinguishes — a semantic change to the
wire contract. Old clients don't *crash* on an unknown kind (the base class
surfaces it via `CambiumError` with the real `kind` string, by design), but the
closed-enum promise is what lets a client trust its mapping is exhaustive. **New
`error.kind` values are a `/v2` boundary, not an additive `/v1` change.**

Because a new kind cannot be added mid-`1.x`, any error condition that a promised
feature needs *must* claim its kind before 1.0. The 0.10 cooperative-cancellation
work is modeled deliberately as a **non-error outcome** (a terminal status on the
success envelope), **not** a 12th `error.kind` — a cancellation the caller
requested is a cooperative result, not a failure. The enum stays at 11.

### 4. Trace step vocabulary

Every run emits a `trace.json` whose steps carry a framework-owned `type`. The
vocabulary is closed and additive: a step type, once shipped, keeps its shape.

- **Additive:** new step types (a new primitive or operator ships with its own).
- **Breaking (MAJOR):** removing a step type or changing an existing type's payload
  shape.
- **Defined in:** every type is enumerated in
  [`C - Trace (observability)`](docs/GenDSL%20Docs/C%20-%20Trace%20%28observability%29.md).
  A new step type requires both the runner change and a `C - Trace` row — the same
  additivity discipline as the IR.

### 5. Runner library API

`@redwood-labs/cambium-runner` is consumable as a library (engine mode, embedding
hosts). Its promised surface is the set of **named exports** from the package entry
point (`packages/cambium-runner/src/index.ts`) — `runGen`, `runGenFromIr`,
`runPipelineFromIr`, `runServe`, `runInspect`, `resolveReplay`, the golden-test
engine, the provider-author contract (`openaiCompatible`, `anthropicCompatible`,
`defineProvider`, `ProviderHttpError`, `ProviderConnectionError`, …), and their
exported types.

- **Additive:** a new named export; a new *optional* key on an options bag
  (`RunGenOptions`, `RunGenFromIrOptions`, `RunServeOptions`, …). New optional keys
  on the `runGen` options bag are the canonical additive extension point.
- **Breaking (MAJOR):** removing an export, renaming one, making an optional options
  key required, or changing an existing function's signature or return shape.
- **Not promised:** anything *not* re-exported from `index.ts`. Deep imports into
  the package's internal modules are unsupported and may change in any release.

### 6. CLI surface

The `cambium` verbs and their flags are a promised surface — scripts and CI that
call the CLI keep working across a major line.

- **Promised verbs:** `init`, `new`, `run`, `replay`, `compile`, `schedule`,
  `serve`, `inspect`, `doctor`, `test`, `lint`.
- **Additive:** new verbs, new subcommands, new flags, new `--arg` input forms.
- **Breaking (MAJOR):** removing a verb or flag, or changing a flag's meaning.
  There are **no CLI surface removals** within a major line.
- **Not promised at the CLI level:** the *human-readable output* of a verb — help
  text, and the report formatting of diagnostic verbs like `doctor` and `lint`. The
  promise is that the verb exists and its flags keep their meaning, not that its
  console rendering is byte-stable. Machine-readable outputs (`compile` IR JSON,
  `run` artifacts) are covered by the IR / trace surfaces above, not here.

---

## Not promised

These are explicitly outside the promise — they may change in any release,
including a PATCH:

- **IR TypeScript type internals** — read the JSON shape instead (surface 2).
- **Runner internals** — any module not re-exported from `index.ts`; deep imports.
- **`--mock` snapshot bytes across model swaps** — mock output is a determinism aid
  for golden tests, not a stable artifact; changing the mock model changes the
  bytes.
- **Golden snapshot file bytes** — the *corpus* pins the IR contract; the snapshot
  files themselves are test fixtures, regenerated as the corpus evolves.
- **`runs/` artifact layout beyond what `cambium replay` / `cambium inspect`
  consume** — the trace *vocabulary* (surface 4) is promised; incidental on-disk
  structure is not.

---

## Deprecation register

Cambium follows the Rails deprecation cycle: **warn in release N, remove in release
N+1.** A deprecated surface keeps working (with a one-time stderr warning) for one
release so authors have a migration window. The following are deprecated in 0.9 and
**removed in 1.0**:

| Deprecated surface | Warning | Migrate to |
|--------------------|---------|------------|
| `registerAppCorrectors` module-global | `[cambium] registerAppCorrectors is deprecated (RED-299); …` | Pass correctors via `RunGenOptions.correctors` (per-`runGen`, no module-global state). |
| `constrain :budget` / `policies.constraints.budget` | `[cambium] policies.constraints.budget is deprecated and will be removed in Cambium 1.0.` | The `budget` primitive (`budget per_run: { … }`). |

After 1.0, any *new* deprecation follows the same cycle: it may be *marked*
deprecated in a MINOR release but is only *removed* in the next MAJOR.

---

## Compatibility proof: the headline deferrals grow in additively

The 1.0 promise is only credible if the features Cambium has *deferred* past 1.0
can still be added **without** breaking a promised surface. Each deferral below has
an additive landing path already open — none is 1.0-blocking:

- **Retrieval / corpora.** `grounded_in :corpus_name` already accepts a symbol
  source; wiring a corpus behind that symbol adds new IR step types and new
  `policies.grounding` fields — all additive (surface 2). No existing field moves.
- **Streaming.** A streaming response is a new `/v1` endpoint (or a new optional
  request field selecting stream mode) plus new trace step types — additive on
  surfaces 3 and 4. The existing unary envelope is untouched.
- **Async retro-agents.** Retro memory-write agents already run post-success; making
  them asynchronous adds new optional IR fields and new trace step types — additive
  on surfaces 2 and 4. The synchronous path stays the default.

None of the three requires a break. That is the test 1.0 has to pass, and it
passes.

---

## See also

- [`CHANGELOG.md`](CHANGELOG.md) — every breaking change, with migrations.
- [`SECURITY.md`](SECURITY.md) — the supply-chain and sandboxing posture.
- [`C - IR (Intermediate Representation)`](docs/GenDSL%20Docs/C%20-%20IR%20%28Intermediate%20Representation%29.md) — the promised JSON shape, field by field.
- [`C - Serve Mode`](docs/GenDSL%20Docs/C%20-%20Serve%20Mode.md) — the `/v1` wire format.
- [`C - Trace (observability)`](docs/GenDSL%20Docs/C%20-%20Trace%20%28observability%29.md) — the trace step vocabulary.
