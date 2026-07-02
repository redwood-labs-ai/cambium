# Road to 1.0

**Status:** point-in-time assessment, written 2026-07-01 at v0.8.1. This is a strategy note, not a spec — it captures where the project stands, what the 1.0 promise should cover, the gate list, and the growth directions after. Expect it to be revised as 0.9 lands.

## Thesis

**Cambium does not have a feature problem on the road to 1.0 — it has a declaration problem.** The project already behaves like a 1.0 project: locked `/v1` wire format with a defined breaking-change boundary, additive-only IR discipline, migration notes on patch releases, golden tests as public API, semver-clean changelogs. What remains is the act of choosing which surfaces the 1.0 promise covers, and cleaning the small number of surfaces that cannot yet be promised.

1.0 is a promise, not a feature level. The work is weeks of deliberate closure, not months of building.

## Where 0.8.1 stands

Evidence snapshot from a full repo + docs survey (2026-07-01):

- **Velocity:** 0.1.0 → 0.8.1 in ten weeks (2026-04-21 → 2026-06-28), seventeen releases, each with disciplined changelog entries, security advisories cited by CVE, and migration notes for behavior shifts invisible under `--mock`.
- **Test surface:** ~1,540 vitest cases + 97 pytest cases. Essentially zero TODO/FIXME debt in shipping source. Error-message DX is a *strength*: 212 Ruby-side raises that name the offending field, list valid values, and show a corrected example.
- **Deferral discipline:** nearly every limitation in the knowledge graph is an explicit, reasoned deferral with a v1.5/v2 tag. The deferred set already reads as a roadmap; it just hasn't been published as one.
- **First external contribution** landed in 0.8.1 (PR #18, Anthropic prompt-prefix caching for grounded fan-outs). People don't contribute caching optimizations to projects they're casually evaluating.
- **Adoption:** three real downstream applications, including one production-track user for whom API stability is already live.

The gaps are narrow and specific — see the gate list.

## The six promise surfaces

Cambium has six distinct API surfaces a 1.0 promise could cover. Readiness varies:

| Surface | State at 0.8.1 | 1.0-ready? |
|---|---|---|
| Ruby DSL vocabulary | One-way-door discipline already practiced (pipeline binding syntax, cron vocabulary explicitly flagged as unremovable-once-shipped) | Yes, after a regret sweep |
| IR shape | Additive-only discipline; single-`model` IRs stay byte-identical across releases | Yes, once pinned by a golden corpus |
| Serve wire format | `/v1` locked; closed `error.kind` enum; breaking-change boundary defined (`/v2` rule) | Yes |
| Trace step vocabulary | Framework-owned, additive; every new step type documented in `C - Trace` | Yes |
| Runner library API | **Weakest surface.** `export type IR = any`; deprecated back-compat shims still present | **No — this is the work** |
| CLI surface | Verbs stable; "No CLI surface removals" holds in every release since 0.3.x | Yes |

## The gate list

Things that must close before the promise is honest. In rough dependency order:

1. **`export type IR = any` must become a real structured type or an officially opaque handle.** It's exported, so it's API — `any` is a promise that can't be kept. (Flagged as a follow-up in 0.3.3; the bill comes due at 1.0.)
2. **Delete the deprecated shims.** `registerAppCorrectors` (superseded by the per-run registry) and the legacy `policies.constraints.budget` parse path. Pre-1.0 is the last cheap window.
3. **Flip strict exec to the default.** `security exec: { allowed: true }` silently meaning unsandboxed `:native` is the one place Cambium doesn't meet its own deny-by-default standard. At 1.0, `CAMBIUM_STRICT_EXEC` behavior is the default and unsandboxed native is an explicit, loudly-declared opt-out. Breaking — belongs in the 0.9 window.
4. **Golden IR corpus.** The DSL→IR mapping *is* the 1.0 contract, and nothing pins it directly today (the Ruby side has zero unit tests; `runtime.rb` and `compile.rb` are exercised only through TS e2e). Cheapest 1.0-grade fix: compile every in-tree gen and pipeline, snapshot the IR JSON, diff on every commit. This turns the compatibility promise into a failing test.
5. **One serve-mode decision.** Unauthenticated + no cancellation is acceptable *if documented as "v1 assumes network isolation."* Given a production-track downstream, the better close is minimal bearer-token auth plus cooperative cancellation (`DELETE /v1/runs/<id>`), with streaming/quotas/hot-reload staying deferred.
6. **The 1.0 compatibility document.** Which of the six surfaces are semver-covered; what "additive" means per surface (IR fields, trace step types, wire fields, DSL kwargs). This document is the deliverable that makes 1.0 real — the release is mostly its announcement.
7. **Compatibility-proof notes for the headline deferrals.** For retrieval/corpora, streaming, and async retro-agents: a short design note proving the current DSL shape can grow into each *additively* (e.g. `grounded_in :corpus_name` already takes a symbol; the IR accepts new step types). Anything that cannot be added additively later is, by definition, 1.0-blocking now. Expected result: nothing is.

### Explicitly not gating 1.0

The long tail of the deferral list does not block the release: Pyodide/WASM-Python, Firecracker read-write filesystem / IPv6 / denylists, streaming responses, pluggable memory backends, URL grounding, log sampling/durable sinks, hierarchical pipelines. Rails 1.0 shipped without a deployment story; Cambium 1.0 can ship without the v1.5 tail. The move is to publish that tail as a roadmap, not to ship it.

## The questions, with leans

**What is the identity sentence at 1.0?** Lean: *Cambium is the framework that makes small, local models reliable enough to trust — and makes model choice a testable refactor.* The deterministic verification stack (schemas, repair, correctors, grounding checks, golden tests) is exactly what closes the reliability gap for a local 27B model, and it is simultaneously what makes swapping `omlx:` for `anthropic:` (or distilling the other direction) provable instead of vibes. `profile :dev/:prod` is the embryo. The 15-minute demo writes itself: `cambium new agent` → `returns` block → run against a local model → golden test pins it → change one `model` line → tests still pass. That demo is the 1.0 announcement.

**Does retrieval/RAG block 1.0?** The `Retrieve` step is the largest spec'd-never-built item — grounding shipped as inline document injection instead, and `D - Grounding Sources` (corpora, connectors, chunking) remains a stub. Lean: **no**, provided the compatibility-proof note (gate item 7) shows the DSL can grow into it additively. Retrieval becomes the flagship post-1.0 direction, not a 1.0 gate.

**What would we break if we could break everything once?** Pre-1.0 is the last cheap breaking window. Sweep for regrets — DSL keyword renames, kwarg shapes, default flips — and bundle every break into one loud 0.9 rather than dribbling them out.

**What do actual users need?** The downstreams point at serve-mode operational hardening (auth, cancellation) — not the exotic tail. Let real usage, not the deferral list, order the work.

## The path

- **0.9 — "The Contract" (the last-call release).** All breaking changes at once: strict exec default, shims deleted, `IR` type resolved, any DSL regrets. Plus the golden IR corpus and the 1.0 compatibility document.
- **0.10 / 1.0-rc — operational close.** Serve auth + cancellation, docs/README sweep, deferral list published as a roadmap.
- **1.0 — a declaration release.** Mostly announcement and documentation. The demo above is the headline.

## After 1.0: three growth directions

Picture the project as a vertical stack — DSL → IR → runner → trace — with unusually disciplined walls. 1.0 freezes the load-bearing walls. Growth then runs in three directions:

**Down, into data.** The retrieval layer: corpora as first-class objects with connectors, embedders, chunking policy, and access policy — the way ActiveRecord made the database disappear. `D - Grounding Sources` is the seed doc.

**Around the loop.** The parts of an eval system already exist without being named: every run leaves a typed trace (a dataset); correctors and grounding verifiers are deterministic scoring functions (metrics); golden tests are a harness. Assembled, that is `cambium eval` — run a gen against a fixture corpus, score with the verifiers already shipped, track quality across model swaps and prompt edits. This is the primitive that makes the model-portability thesis operational, and it costs almost no new machinery. The trace stops being an audit artifact and becomes a dataset.

**Out, into ecosystem.** Tools, correctors, providers, and policy packs are already plugin surfaces with load-order and honesty rules. Post-1.0 that becomes a registry — the gems moment. And note what the IR quietly is: the Ruby DSL is a compile-time-only frontend; the runtime is pure Node. A frozen, documented IR is a *target* — other authoring frontends could emit it. The IR, not the Ruby, may turn out to be the product.

## Risks

- **Single-maintainer attention is the binding constraint.** 1.0 invites users; users invite support load. Mitigation is already built (the invariant docs, the knowledge graph, CI review running Cambium on Cambium) — but the roadmap should be shaped to protect attention, not just to sequence features.
- **Support-surface creep.** Every surface declared semver-stable at 1.0 is a surface that must be maintained under that promise indefinitely. When in doubt, declare less: it is always possible to promote a surface into the promise later; never possible to demote one out.

## Triage: candidate issues

The gate list and path decompose into fileable issues. Grouped by window:

**0.9 window (breaking + contract):**
1. Golden IR corpus — snapshot compiled IR for every in-tree gen/pipeline; diff in CI.
2. Resolve `export type IR = any` — structured type or officially opaque.
3. Remove deprecated shims (`registerAppCorrectors`, legacy `policies.constraints.budget` parsing).
4. Strict exec becomes default; unsandboxed `:native` becomes explicit opt-out.
5. DSL regret sweep — inventory keyword/kwarg/default regrets before freeze (meta-issue).
6. Write the 1.0 compatibility document (surfaces covered, additivity rules per surface).
7. Compatibility-proof notes: retrieval/corpora, streaming, async retro-agents.

**0.10 / rc window (operational):**
8. Serve: minimal bearer-token auth.
9. Serve: cooperative cancellation (`DELETE /v1/runs/<id>`).
10. README: engine-mode section missing 0.8.1's own engine-mode providers feature (trivial).
11. Publish the deferral list as a public roadmap document.

**Post-1.0 seeds (design notes, not code):**
12. `cambium eval` design note — traces as datasets, verifiers as metrics.
13. Retrieve step / corpus layer design note — the additive path from `grounded_in`.
14. Thin-coverage close: 1:1 tests for log backends, `web_search`/`web_extract` tools.
