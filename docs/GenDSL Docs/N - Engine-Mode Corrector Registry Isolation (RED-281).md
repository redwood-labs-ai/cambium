## Note: Engine-Mode Corrector Registry Isolation

**Doc ID:** gen-dsl/note/engine-mode-corrector-registry
**Status:** Shipped — RED-299
**Last edited:** 2026-04-20

---

## Purpose

RED-275 landed the app-level corrector plugin system on top of a mutable module-global registry (`packages/cambium-runner/src/correctors/index.ts`). For the CLI — a one-shot process — that works cleanly: `loadAppCorrectors` in `main()` populates the registry, `runGen` reads it, process exits. No isolation concern.

For a long-lived engine-mode host — a library consumer that imports `runGen` from `@redwood-labs/cambium-runner` and drives multiple `runGen` calls in one process — the module-global registry is wrong. Correctors from call N leak into call N+1. A host loading two apps with a same-named corrector gets the second load's version silently replacing the first, with no per-call scoping.

This note settles *where* the registry should live and *when* to promote the fix to an impl ticket. Explicitly not shipping code today — the CLI path is correct and no engine-mode host yet exists to trip the gap.

---

## Current state

```ts
// packages/cambium-runner/src/correctors/index.ts
export const correctors: Record<string, CorrectorFn> = {
  math, dates, currency, citations,
};

export function registerAppCorrectors(extras: Record<string, CorrectorFn>): void {
  for (const [name, fn] of Object.entries(extras)) {
    // one-time warning on override
    correctors[name] = fn;
  }
}
```

Two call sites populate the global:

1. **CLI** (`cli/cambium.mjs` → `main()` → `loadAppCorrectors(genfileDir)`): loads once per process, before any `runGen`. Correct for the CLI model.
2. **Runner** (`packages/cambium-runner/src/runner.ts:603–608`): when engine mode is detected, loads sibling correctors via `registerAppCorrectors(engineCorr.correctors)`. This mutates the global *inside* `runGen` — fine for the first call; observably wrong if a host runs two engines in one process.

The gap is already flagged in code — `correctors/index.ts:13–18` has a comment pointing at this design note as the next step. The `_resetAppCorrectorsForTests` escape hatch (`correctors/index.ts:47`) is test-only and explicitly not intended as a production API.

---

## Grounding: the tool/action comparison

RED-281's original description claimed "same mutable-global pattern likely applies to the tool and action registries." Reading the code, that turns out to be wrong:

- `ToolRegistry` (`packages/cambium-runner/src/tools/registry.ts:32`) is a **class with private Maps**. `runGen` does `const toolRegistry = new ToolRegistry()` at `runner.ts:574` — fresh per call, no cross-call leakage.
- `ActionRegistry` (`packages/cambium-runner/src/actions/registry.ts:38`) mirrors that shape. Fresh `new ActionRegistry()` at `runner.ts:590`.
- Memory pools and policies are IR-embedded (compiled into `policies.memory` / `policies.security`), so they're per-gen by construction.

The corrector registry is the **only** outlier. That narrows the scope of this note from "architectural pattern refactor across four subsystems" to "bring the corrector registry into line with the pattern tools/actions already use."

This also changes the weight of fork #2 (parallel question): there's nothing to do there.

---

## Decisions

### 1. The registry moves to per-`runGen` options, matching the tool/action + schema pattern

New `RunGenOptions.correctors?: Record<string, CorrectorFn>` field. Optional; when omitted, the runner uses framework built-ins (`math`, `dates`, `currency`, `citations`) only. When supplied, the passed map is merged on top of built-ins with the same precedence rule RED-275 established (app wins on collision, one-time stderr warning).

Caller shape:

```ts
import { runGen, builtinCorrectors } from '@redwood-labs/cambium-runner';
import { my_app_corrector } from './correctors/my_app.corrector';

await runGen({
  ir, schemas,
  correctors: { ...builtinCorrectors, my_app: my_app_corrector },
});
```

A new export `builtinCorrectors: Record<string, CorrectorFn>` gives hosts a fresh copy of the framework built-ins without a dangling reference to the old module-global `correctors` export. Hosts that want to disable a built-in can omit it; hosts that want pure app-only correctors can pass only their own.

The CLI (`cli/cambium.mjs` → `main()`) collects app correctors via `loadAppCorrectors(genfileDir)` as today, merges with `builtinCorrectors`, and passes the merged map into `runGen` — no more module-global mutation.

The runner (`runner.ts:603–608`) collects engine-sibling correctors and merges them onto the passed-in map for *this call only*. No global state touched.

### 2. Tools, actions, pools, policies — already isolated

Named above. Cross-reference; no work needed. A future refactor that wanted to unify the pattern (e.g., a single `plugins: { tools, actions, correctors }` option on `RunGenOptions`) could be filed later, but nothing about this is forced by the corrector isolation fix.

### 3. Back-compat

Changing `RunGenOptions` is a breaking change for callers that rely on the current module-global. Today that's:

- The CLI — in-tree caller, updates atomically with the runner.
- The `registerAppCorrectors` public export — used in tests (`_resetAppCorrectorsForTests` companion). Keep the function but deprecate it: it becomes a no-op wrapper that pushes into a process-global "legacy" map, which the runner merges at lowest precedence when `opts.correctors` is absent. Emits a one-time stderr deprecation.
- External engine-mode hosts — do not exist yet (per the "actively building on API stability" memory; external callers rely on `@redwood-labs/cambium-runner`'s published surface). Ship the new shape; document the migration in the same PR.

The `correctors: Record<string, CorrectorFn>` export stays for backward reference but is re-exported from `builtinCorrectors`'s container. Hosts that reached into the module-global directly get a deprecation warning.

---

## Rationale

### Why per-`runGen` (fork 1A) is the right choice

- **Consistency.** Tools, actions, schemas already work this way. Correctors are the outlier; lining them up removes a surface a new engine-mode user has to learn.
- **Explicit > magic.** Fork 1B (per-app-root keyed registry) would infer the right registry from the IR's source-gen location. Works, but introduces a second way the runner "finds" things, and debugging "why didn't my corrector run" becomes "which registry did the runner think we were using?"
- **No new burden on the caller beyond what exists.** A host already passes `schemas` — adding `correctors` next to it is a single line, not a new mental model.
- **Fork 1C (keep global + clear API) inverts the default.** Hosts would have to remember to call `clearAppCorrectors()` between apps; forgetting it is a silent wrong-result bug. Explicit-per-call makes forgetting impossible.

### Why ship a `builtinCorrectors` export

`correctors: { math, dates, ... }` as a process-global export made the CLI's life easy but creates a dependency graph where every runner module holds a reference to the mutable map. Moving the map into `RunGenOptions` means the built-ins need a fresh access point. A pure function that returns a new object each call (`getBuiltinCorrectors()`) would also work but is less ergonomic; a shallow-immutable `Record` export matches how hosts already consume `schemas` from their contracts module.

---

## Rejected alternatives

- **Per-app-root keyed registry (fork 1B).** See rationale above. The inference is cute until it misfires.
- **Global + `clearAppCorrectors()` (fork 1C).** Puts the burden on the caller to remember teardown. Silent wrong-result on forget.
- **Embed correctors in the IR like memory pools.** Correctors are executable code (TS functions), not data. Embedding them would mean either shipping source in the IR (violates "IR is truth, not code") or pre-resolving to function references (breaks IR portability). Tools/actions ship JSON + handler files separately for exactly this reason; correctors follow the same pattern.
- **AsyncLocalStorage-scoped global.** Per-`runGen` isolation via Node's `AsyncLocalStorage`. Works but is invisible magic; every caller would have to wrap `runGen` in `als.run(...)` anyway — same ceremony as passing an option, with more indirection.

---

## Triggers for promotion to impl

Any one of:

1. **First real engine-mode host** that loads multiple unrelated apps in one process. The forcing case RED-220 anticipated — when it appears, ship this immediately.
2. **A reported silent corrector override** across runs in one process. Symptom: app A's `foo.corrector.ts` runs for app B's gen that declared `corrects :foo`.
3. **A new engine-mode user asking** "how do I scope my correctors to just my app" — their mental model is correct; the current answer is wrong.
4. **A test pattern emerging** that requires multiple per-run corrector configurations in one test file without the `_resetAppCorrectorsForTests` escape hatch.

Until one of those triggers, the current code is correct for the only caller that exists (the CLI) and the code comment at `correctors/index.ts:13–18` flags the gap for anyone who trips on it.

---

## Implementation sketch

If/when promoted, the impl ticket has roughly this shape:

### `packages/cambium-runner/src/correctors/index.ts`

- `correctors` mutable-module-global becomes `builtinCorrectors: Record<string, CorrectorFn>` (named export, same shape).
- `registerAppCorrectors` becomes a deprecated no-op-with-warning that writes into a legacy module-global map; runner merges that last when `opts.correctors` is absent.
- `_resetAppCorrectorsForTests` can be deleted — tests pass `correctors` via `RunGenOptions`.
- `runCorrectorPipeline` takes a `correctors: Record<string, CorrectorFn>` parameter explicitly rather than reading the module-global.

### `packages/cambium-runner/src/runner.ts`

- `RunGenOptions.correctors?: Record<string, CorrectorFn>` added next to `schemas`.
- Merge order at runner start: `builtinCorrectors` → `opts.correctors ?? {}` → engine-sibling correctors loaded via `loadAppCorrectors(engineDir)` → local `const correctors = { ... }`.
- Pass that local map to `runCorrectorPipeline` everywhere it's called.

### `cli/cambium.mjs`

- `main()` merges app correctors + framework built-ins and passes via `runGen({ correctors, ... })`.
- No more `registerAppCorrectors` call in the CLI path.

### Tests

- `corrector-feedback.test.ts` switches from `registerAppCorrectors({...})` + `_resetAppCorrectorsForTests()` to passing `correctors` directly on each `runGen` call. Cleaner, no per-test teardown.
- New test: two back-to-back `runGen` calls with different `correctors` maps produce correctly scoped results. This is the invariant that today's global-registry code silently violates.

Estimated lift: ~60–80 LOC plus test updates. 1–2 hours of focused work once the triggers fire.

---

## Out of scope

- **Generalizing to a unified plugin map** (`opts.plugins: { tools, actions, correctors }`). Cute, not forced; the current three-option shape is fine if someone comes back and wants unification later.
- **Tool/action/pool/policy isolation.** Already isolated; nothing to do.
- **Deprecation schedule for `registerAppCorrectors`.** Decide at impl time based on whether any external callers have emerged. If zero, remove in the next minor.
- **AsyncLocalStorage-scoped alternative.** Rejected above; revisit only if a pattern emerges where every call site also wants async-context-scoped something-else (logs, traces, budgets).

---

## See also

- [[P - corrects (correctors)]]
- [[N - App Mode vs Engine Mode (RED-220)]] — engine-mode host is the motivating context
- RED-275 — shipped the app-corrector plugin system on top of the global registry
- RED-243 — precedent for the caller-injected pattern (schemas moved from `import(contracts.ts)` to `opts.schemas`)
- RED-287 — engine-mode runtime catch-up; added `engineDir` to `RunGenOptions` following the same pattern
