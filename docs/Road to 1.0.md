# Road to 1.0

**Status:** point-in-time assessment, written 2026-07-01 at v0.8.1; revised 2026-07-03 with a Rails-doctrine decision pass (see *Rails doctrine → 1.0 decisions*) that lands gates 1–3 and the thesis demo; revised 2026-07-23 to fold in the first substantive external code contribution (PR #20, fan-out cache prewarm — see *Triage*). This is a strategy note, not a spec — it captures where the project stands, what the 1.0 promise should cover, the gate list, and the growth directions after. Expect it to be revised again as 0.9 lands.

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
| Runner library API | **Weakest surface.** `export type IR = any`; deprecated back-compat shims still present | **Yes — once declared opaque** (IR is Arel; shims deprecated, not restructured). Downgraded from "the work" by the Rails-doctrine pass below. |
| CLI surface | Verbs stable; "No CLI surface removals" holds in every release since 0.3.x | Yes |

## Rails doctrine → 1.0 decisions

The project's north star is the Rails doctrine, and several open 1.0 questions resolve the moment they're run through it. Recording the mapping so the decisions are portable — future forks get settled the same way rather than re-litigated, and the gate list below can just point here.

| Doctrine | What it decides | Decision |
|---|---|---|
| **IR is Arel** — Rails keeps its intermediate representation (the query AST) private; it promises the DSL and the result, never the AST between them. | Gate 1: opaque vs. structured `IR` type. | Split the surface the doc was conflating. The IR **JSON shape** is a data contract (like `schema.rb`): additive-only, golden-pinned, promised. The IR **TypeScript type** (`export type IR`) is Arel — `export type IR = OpaqueIR`, an opaque handle, unpromised. Keeps the "IR as product" growth path open (Arel was eventually promoted) without paying for it at 1.0. |
| **Secure by default** — CSRF, strong params, escaped output: Rails ships the safe default and trusts you to opt out. | Gate 3: strict exec. | Flip it. Strict is the default; unsandboxed native is a **sharp knife** — available but loud and explicit (e.g. `security exec: { unsafe_native: true }`, keeping the `tool.exec.unsandboxed` trace step). Aligning with the one Rails value Cambium currently violates, not just "a break we should do." |
| **Deprecation cycle** — Rails breaks constantly but almost never *silently*: warn in N, remove in N+1. | Gate 2: the shims. | **Deprecate in 0.9, remove at 1.0.** Not delete-now. A named production downstream (gaia_solver) reads `constraints.budget` — warn it, don't silent-break it. Same destination, Rails-legitimate path. |
| **Test behavior, not bytes** — Rails system tests assert "the page shows the name," never HTML byte-equality. | Q1: the "testable refactor" thesis. | The 1.0 demo asserts the **contract suite is green** across a model swap (schema + correctors + grounding + signals all `ok: true` against the new model's *real* output), not that the `--mock` snapshot is unchanged. That assertion mode is `cambium eval` in embryo; the 1.0 story needs the embryo, not the deferred product. |
| **Options bags grow additively** — Rails evolves APIs by adding keyword args, not changing signatures. | Q3: cancellation vs. the runner-API freeze. | `runGen({…})` already takes an options object; `signal?` is an additive key, and with the runner API opaque (row 1) the internal `AbortSignal` threading is free to change. No freeze collision — cancellation stays in the 0.10 window. |
| **Error messages are UX** — `did_you_mean`, helpful-exception pages: Rails treats a good error as a feature with a test. | Gate 4 scope. | The 212 field-naming raises are a promised surface. The golden corpus gets a **rejection half** (malformed DSL → expected error text) to protect them during the regret sweep that churns them. |
| **Exalt beautiful code / convention over configuration** — Rails names by one consistent grammar. | The regret sweep (0.9 triage). | The sweep audits for **naming-convention consistency** — one verb/noun grammar across every keyword — not just one-off regrets. Hand it to fresh eyes; the author is worst-placed to see their own regrets. |

## The gate list

Things that must close before the promise is honest. Several are now **decided** by the Rails-doctrine pass above; those carry the deciding principle inline. In rough dependency order — the corpus is gate zero, it lands first as the safety net the breaks fall under:

1. **`export type IR = any` → opaque handle. (Decided: IR is Arel.)** Rails keeps its intermediate representation private and promises the DSL + the result, never the AST between. So the IR *JSON shape* stays a promised, additive, golden-pinned data contract, while the exported *TypeScript type* becomes `export type IR = OpaqueIR` — an opaque, unpromised handle. Shrinks from "the work" to an afternoon plus one sentence in the compatibility document. (Flagged as a follow-up in 0.3.3; the bill comes due at 1.0.)
2. **Deprecate the shims in 0.9, remove at 1.0. (Decided: deprecation cycle.)** `registerAppCorrectors` (superseded by the per-run registry) and the legacy `policies.constraints.budget` parse path. Rails breaks constantly but almost never *silently* — warn in N, remove in N+1. A named production downstream (gaia_solver) reads `constraints.budget`, so 0.9 emits a deprecation warning + changelog migration note and 1.0 does the removal. Same destination as "delete now," Rails-legitimate path.
3. **Flip strict exec to the default. (Decided: secure by default.)** `security exec: { allowed: true }` silently meaning unsandboxed `:native` is the one place Cambium doesn't meet its own deny-by-default standard — and secure-by-default is Rails' proudest contribution. Strict becomes the default; unsandboxed native stays available as a **sharp knife** — loud and explicit (e.g. `security exec: { unsafe_native: true }`, keeping the `tool.exec.unsandboxed` trace step). Breaking — 0.9 window.
4. **Golden IR corpus — gate zero.** The DSL→IR mapping *is* the 1.0 contract, and nothing pins it directly today (the Ruby side has zero unit tests; `runtime.rb` and `compile.rb` are exercised only through TS e2e). It lands *first*, before the breaks in 2 and 3, so it catches their regressions. Two halves: an **acceptance** corpus (compile every in-tree gen/pipeline, snapshot the IR JSON, diff on every commit) and a **rejection** corpus (malformed DSL → expected error text) — because in Rails a good error message is UX with a test, and the 212 field-naming raises are exactly what the regret sweep will churn. This turns the compatibility promise into a failing test.
5. **One serve-mode decision.** Unauthenticated + no cancellation is acceptable *if documented as "v1 assumes network isolation."* Given a production-track downstream, the better close is minimal bearer-token auth plus cooperative cancellation. Cancellation is an **additive** `signal?` key on the `runGen` options bag (Rails grows APIs by adding keyword args, not changing signatures) and its internal `AbortSignal` threading is private under the now-opaque runner — so it does *not* collide with the API freeze and can land in the 0.10 window. Streaming/quotas/hot-reload stay deferred.
6. **The 1.0 compatibility document — written first, as a living doc.** Which of the six surfaces are semver-covered; what "additive" means per surface (IR fields, trace step types, wire fields, DSL kwargs, and new optional keys on the `runGen` options bag). It's the deliverable that makes 1.0 real, so it's opened at the *start* of 0.9 and the other gates fill it in — starting it last risks discovering at the end that a surface assumed additive isn't. The **compatibility-proof notes** for the headline deferrals (retrieval/corpora, streaming, async retro-agents — each proving the current DSL grows into it additively, e.g. `grounded_in :corpus_name` already takes a symbol and the IR accepts new step types) live here as a *section*, not a separate gate; anything that cannot be added additively later is, by definition, 1.0-blocking now. Expected result: nothing is.

### Explicitly not gating 1.0

The long tail of the deferral list does not block the release: Pyodide/WASM-Python, Firecracker read-write filesystem / IPv6 / denylists, streaming responses, pluggable memory backends, URL grounding, log sampling/durable sinks, hierarchical pipelines. Rails 1.0 shipped without a deployment story; Cambium 1.0 can ship without the v1.5 tail. The move is to publish that tail as a roadmap, not to ship it.

## The questions, with leans

**What is the identity sentence at 1.0?** Lean: *Cambium is the framework that makes small, local models reliable enough to trust — and makes model choice a testable refactor.* The deterministic verification stack (schemas, repair, correctors, grounding checks, golden tests) is exactly what closes the reliability gap for a local 27B model, and it is simultaneously what makes swapping `omlx:` for `anthropic:` (or distilling the other direction) provable instead of vibes. `profile :dev/:prod` is the embryo. The 15-minute demo writes itself: `cambium new agent` → `returns` block → run against a local model → change one `model` line → the **contract suite stays green** — schema, correctors, grounding, and signals all pass against the new model's *real* output. (Rails asserts the rendered outcome, never byte-identical HTML; a model swap moves the bytes, so the golden `--mock` snapshot — which pins one model deterministically — is the wrong altitude for the swap, and the contract assertions are the right one.) That assertion mode is `cambium eval` in embryo; the demo is the 1.0 announcement.

**Does retrieval/RAG block 1.0?** The `Retrieve` step is the largest spec'd-never-built item — grounding shipped as inline document injection instead, and `D - Grounding Sources` (corpora, connectors, chunking) remains a stub. Lean: **no**, provided the compatibility-proof note (now a section of gate 6, the compatibility document) shows the DSL can grow into it additively. Retrieval becomes the flagship post-1.0 direction, not a 1.0 gate.

**What would we break if we could break everything once?** Pre-1.0 is the last cheap breaking window. Sweep for regrets — DSL keyword renames, kwarg shapes, default flips — and bundle every break into one loud 0.9 rather than dribbling them out. Two Rails caveats: where a *named downstream already depends on a shim*, the deprecation cycle applies (warn in 0.9, remove at 1.0) rather than a silent break; and the sweep itself audits for **naming-convention consistency** — one verb/noun grammar across every keyword — not just one-off regrets. Hand it to fresh eyes; the author is worst-placed to see their own regrets.

**What do actual users need?** The downstreams point at serve-mode operational hardening (auth, cancellation) — not the exotic tail. Let real usage, not the deferral list, order the work.

## The path

- **0.9 — "The Contract" (the last-call release).** The golden IR corpus lands *first* as the safety net, then the breaks land under it: strict exec becomes the default (unsandboxed native → loud sharp-knife opt-out), the `IR` type goes opaque, and the DSL regret sweep runs. The shims are *deprecated* here (removed at 1.0, not now). The 1.0 compatibility document is opened at the start of the window as a living doc the rest of it fills in.
- **0.10 / 1.0-rc — operational close.** Serve bearer-token auth + cooperative cancellation (an additive `signal` on the `runGen` options bag — no freeze collision), docs/README sweep, deferral list published as a roadmap.
- **1.0 — a declaration release.** The deprecated shims are removed; otherwise mostly announcement and documentation. The demo above — asserting the contract stays green across a model swap, not a byte-identical snapshot — is the headline.

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
1. Golden IR corpus — **gate zero, lands first.** Acceptance half (snapshot compiled IR for every in-tree gen/pipeline; diff in CI) + rejection half (malformed DSL → expected error text, pinning the field-naming raises).
2. Resolve `export type IR = any` → opaque `OpaqueIR` handle (IR is Arel); keep the IR *JSON shape* as the promised, golden-pinned contract.
3. **Deprecate** `registerAppCorrectors` + legacy `policies.constraints.budget` in 0.9 (warning + migration note); **remove at 1.0**.
4. Strict exec becomes default; unsandboxed `:native` → loud sharp-knife opt-out (e.g. `unsafe_native: true`).
5. DSL regret sweep — audit for naming-convention consistency (one verb/noun grammar); hand to fresh eyes (meta-issue).
6. Write the 1.0 compatibility document **first, as a living doc** (surfaces covered, additivity rules per surface incl. `runGen` options keys); the compatibility-proof notes (retrieval/corpora, streaming, async retro-agents) are a section of it, not a separate issue.

**0.10 / rc window (operational):**
7. Serve: minimal bearer-token auth.
8. Serve: cooperative cancellation — additive `signal` on the `runGen` options bag (`DELETE /v1/runs/<id>` at the wire layer).
9. README: engine-mode section missing 0.8.1's own engine-mode providers feature (trivial).
10. Publish the deferral list as a public roadmap document.

**Post-1.0 seeds (design notes, not code):**
11. `cambium eval` design note — traces as datasets, verifiers as metrics. (The thin *contract-assertion* embryo — assert the contract stays green across a model swap — is pulled forward into the 1.0 demo; the full eval product stays here.)
12. Retrieve step / corpus layer design note — the additive path from `grounded_in`.
13. Thin-coverage close: 1:1 tests for log backends, `web_search`/`web_extract` tools.

### External contribution: PR #20 — fan-out cache prewarm

The project's first substantive external code contribution (Kenneth, `kennethsqe`; his ref AIE-1046). Landed after the gate list above was drawn, so it's folded in here rather than renumbered into it. Needs a RED ticket on our side for tracking. **The work looks good** (contributor ran security / docs-drift / correctness passes + live-Anthropic QA, docs already updated in the diff); the notes below are about *placement in the release*, not about whether to take it.

It auto-fires one tiny warm-up per distinct `(model tier × grounded prefix)` before a `concurrency > 1` fan-out dispatches, so the branches read the shared cacheable prefix from cache instead of all racing cold and each re-writing it at 1.25× (the AIE-1000 cost regression). Additive IR/trace (`operators[].prewarm_cache`, `PipelineFanOut.meta.prewarm`, absent-when-unset → pre-existing IR byte-identical); opt out with `prewarm_cache false`.

**Where it lands:** the **0.9 window**, gated behind the golden corpus (item 1). It is *additive, not a break* — so it's low-risk — but it introduces one new DSL kwarg, and the DSL vocabulary is a promised 1.0 surface, so the kwarg name is a one-way door that must be settled in 0.9, not merged casually.

14. **[0.9] Merge PR #20 *after* the golden corpus (item 1), rebased onto it.** No collision with existing snapshots (the new IR field is absent-when-unset, so every current snapshot stays byte-identical), but the PR's ad-hoc `compile_pipeline.test.ts` cases should become golden **acceptance** snapshots (a fan-out using `prewarm_cache`) plus a **rejection** case (`prewarm_cache` on a non-fan_out / bad value) — the new field becomes a pinned contract from day one, which is exactly what gate zero is for.
15. **[0.9] `prewarm_cache` goes through the naming-convention sweep (item 5).** Is the verb/noun grammar consistent with the other `fan_out` options? The sweep rules on it *before* 1.0 promises the DSL surface — after that it's unremovable.
16. **[0.10] Per-model cache floor.** The single `MIN_CACHE_PREFIX_CHARS` gate doesn't know Haiku/Opus's 4096-token cache floor (vs Sonnet's 2048), so a mid-size prefix on those tiers fires a warm-up that silently can't cache — wasted spend, no failure. Contributor-flagged; polish, not blocking.
17. **[0.10] Fan-out has no pre-dispatch token-budget gate** (pre-existing). Prewarm now adds real spend into that ungated space. Consistent with the "budget is cooperative, not preemptive" stance ([`N - Orchestration Layer`](GenDSL%20Docs/N%20-%20Orchestration%20Layer.md)), but prewarm makes the gap more visible — worth naming as its own issue.
18. **[FIXED] Anthropic provider unconditionally sends `temperature`,** which 400s on Opus 4.8/4.7, Sonnet 5, and Fable 5 — so prewarm (and gens generally) can't target the newest models. Fixed in branch `fix/anthropic-temperature` (commit `751fd23`) via `acceptsSamplingParams` accept-list in `packages/cambium-runner/src/providers/anthropic.ts`. Unknown/future model ids default to omitting temperature (safe direction).
