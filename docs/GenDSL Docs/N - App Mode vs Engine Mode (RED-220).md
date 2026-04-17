## Note: App Mode vs Engine Mode

**Doc ID:** gen-dsl/note/app-vs-engine-mode
**Status:** Draft (RED-220)
**Last edited:** 2026-04-16

---

## Purpose

Cambium has two integration shapes. Naming them and pinning their conventions removes the ambiguity that has been hanging over questions like "where does the IR live?", "how does a host project import a gen?", and "do schemas live in `contracts.ts` forever?". This note settles the questions that have to be settled before the implementation work can be filed; it explicitly defers everything that doesn't.

This note does not introduce a new primitive. It is a packaging and discovery convention layered over the existing DSL, IR, and runner.

---

## The two modes

### App mode

You build the whole product in Cambium. The monorepo *is* the app. Layout is the current `packages/cambium/app/{gens,systems,tools,policies,memory_pools,actions}` convention; the runner finds everything by walking known paths under `process.cwd()`.

This is what every gen in the repo today is.

### Engine mode

A self-contained agentic DSL environment, embedded in someone else's existing Node/TS application. The Rails-engine analogy: a folder that knows how to describe itself to its parent project. The host writes:

```ts
import { summarize } from './cambium/summarizer';
const result = await summarize({ document: rawText });
```

…and gets a typed function. The folder owns the gen, system prompt, schemas, policy, memory pools, compiled IR, and a generated wrapper. Copy-paste the folder into another project; nothing breaks because nothing leaks outside.

This is the gap RED-220 closes.

### What is mode-agnostic

Most of Cambium does not change between modes:

- Ruby DSL + compiler emit IR identically.
- TS runner executes IR identically.
- Memory, correctors, triggers, signals, grounding, tool dispatch, policy enforcement: all identical.

What changes between modes is **discovery and packaging**, not semantics. Three places in the runner today encode app-mode assumptions and have to become injectable:

| Touchpoint | Today (`packages/cambium-runner/src/runner.ts`) | Engine-mode requirement |
| --- | --- | --- |
| Schema lookup | `import('packages/cambium/src/contracts.ts')` then `mod[ir.returnSchemaId]` | Schemas are passed in by the caller |
| Tool/action discovery | `loadFromDir('packages/cambium/app/{tools,actions}')` | Search dir is configurable |
| `runsRoot` | `join(cwd(), 'runs')` | Configurable per call |

These are the only three. Everything else inside `runner.ts` is mode-agnostic already.

---

## Engine-mode folder shape

```
my-node-app/
├── package.json                     # adds @cambium/runner as a dep
├── src/
│   └── index.ts                     # import { summarize } from '../cambium/summarizer'
└── cambium/
    └── summarizer/
        ├── cambium.engine.json      # marker + minimal manifest (the sentinel)
        ├── CLAUDE.md                # scaffold-emitted: "you are inside an engine folder"
        ├── summarizer.cmb.rb        # the gen (Ruby — dev-time only)
        ├── summarizer.system.md     # system prompt next to the gen
        ├── schemas.ts               # TypeBox: DocumentSummary, etc.
        ├── summarizer.policy.rb     # optional, co-located (NOT under app/policies/)
        ├── summarizer.ir.json       # produced by `npx cambium compile`
        └── index.ts                 # generated: typed wrapper
```

Three principles:

1. **The folder is the unit of portability.** Everything one gen needs lives in one folder. No upward references except to `@cambium/runner` and the host's `package.json`.
2. **Generated files are committed.** `summarizer.ir.json` and `index.ts` are produced by `cambium compile` but checked into the host repo. The host should not need Ruby to *run*, only to *modify*. (See "Ruby is a dev-time dependency" below.)
3. **NO `app/<type>/` subdirectories inside an engine folder.** This is the trap that bit a real attempt — see the next section. Tools, policies, pools, and systems are siblings of the gen, addressed by `<name>.tool.ts`, `<name>.policy.rb`, etc. If a single engine folder grows enough adjacent files to feel cluttered, it has likely outgrown engine mode and should become an app-mode workspace.

---

## Authoring failure modes (from a real attempt)

A first integration attempt against an existing agent-first repo hit predictable Claude-assisted authoring confusion. Files ended up at paths like `cambium/summarizer/app/policies/foo.policy.rb` — the assistant remembered the app-mode `app/<type>/<name>` convention and recreated it inside the engine folder, producing the `app/app`-style nesting.

The runtime then either silently ignores those files (the walk-up search looks for `cambium/policies/`, not `cambium/summarizer/app/policies/`) or, worse, finds them and reinforces the wrong layout for next time.

This is not a "Claude is dumb" problem — it's a docs-and-defaults problem. The mode is currently implicit; the assistant has no way to know which one it's authoring against, so it falls back to the convention with the most prior-art weight (the monorepo).

The fix has three layers:

1. **A sentinel file in every engine folder** that makes "I am in engine mode" detectable at filesystem level. See decision 5 below.
2. **A scaffolder that refuses to guess.** `cambium new <thing>` detects the sentinel and either drops siblings of the gen (engine mode) or under `app/<type>/` (app mode). Without a sentinel and without a workspace `Genfile.toml`, it errors with "no Cambium context detected — run `cambium new engine <Name>` first."
3. **A scaffold-emitted `CLAUDE.md` inside the engine folder** that explicitly tells future LLM sessions what mode they're in: *"You are inside a Cambium engine folder. Tools, policies, systems, and pools are siblings of the gen. Do not create `app/` subdirectories. Use `cambium new tool <Name>` rather than writing tool files by hand."*

The third layer is the cheapest and most effective. The first two make it enforceable.

---

## Architectural decisions

These are the five pieces that need to be settled here so the impl tickets can be filed without churn.

### 1. Schema resolution: caller-injected, not file-imported

**Decision:** The runner takes a `schemas` object as input. It never imports a TS file by path.

The IR continues to carry a string schema name (`ir.returnSchemaId`). The runner does `schemas[ir.returnSchemaId]` to resolve it. It is the caller's job to construct that object — by importing from `contracts.ts` (app mode) or from a sibling `schemas.ts` (engine mode).

```ts
// what runner.ts does today (line 430):
const contractsMod = await import(join(cwd(), 'packages/cambium/src/contracts.ts'));
const schema = contractsMod[ir.returnSchemaId];

// what runGen will accept:
runGen(ir, { input, schemas, runsRoot, env, ... });
//                  ↑ caller provides
```

**Why this option, not the alternatives:**

- *Compiler reads the TS file* — couples the Ruby compiler to the TS module graph. Brittle (any TS syntax change breaks compile) and breaks the "IR is the contract" stance: the compiler should not need TS to be installed to emit IR.
- *Schemas embedded in the IR* — would require the compiler to parse TypeBox into JSON Schema at compile time. We already produce JSON Schema downstream of TypeBox; the duplication risk is real but the bigger problem is that engine-mode users want to evolve their schema without recompiling the IR. Caller-injected schemas let them recompile only when the *gen* changes.
- *Caller-injected* (chosen) — the runner has zero filesystem knowledge of where schemas live. App mode keeps a one-line `contracts` shim that imports `packages/cambium/src/contracts.ts` and forwards. Engine mode's generated `index.ts` imports the sibling `schemas.ts`. Both call the same `runGen`.

**Compile-time validation:** The Ruby compiler still does not validate that a named schema exists in any TS file — it never could. Today's failure mode (runtime "Schema not found in contracts.ts for id: X") becomes "Schema not found in injected schemas: X". The error message changes; the timing does not.

### 2. `runGen` API surface

**Decision:** Single library entry point. All app-mode hardcoded paths become optional fields.

```ts
import { runGen, type GenResult } from '@cambium/runner';

interface RunGenOptions {
  input: unknown;                              // the gen's input
  schemas: Record<string, TSchema>;            // caller-injected; required
  runsRoot?: string;                           // default: join(cwd(), 'runs')
  toolsDir?: string | string[];                // additional dirs for plugin tools
  actionsDir?: string | string[];              // additional dirs for actions
  env?: Record<string, string>;                // API keys, model overrides
  sessionId?: string;                          // overrides CAMBIUM_SESSION_ID
  memoryKeys?: Record<string, string>;         // overrides --memory-key
}

interface GenResult {
  output: unknown;                             // validated against the schema
  trace: TraceObject;                          // same shape as runs/<id>/trace.json
  runId: string;
}

async function runGen(ir: IR, opts: RunGenOptions): Promise<GenResult>;
```

**Pinned semantics:**

- **Builtins always loaded.** Framework-builtin tools (`packages/cambium-runner/src/builtin-tools/`) and actions (`packages/cambium-runner/src/builtin-actions/`) are always loaded, in `@cambium/runner`'s own package. `toolsDir` / `actionsDir` add user-supplied dirs *on top*; they do not replace builtins. App-tool override semantics from RED-209 / RED-221 are preserved (later loads win on name collision).
- **`runsRoot` is process-relative by default.** Passing nothing gets `join(cwd(), 'runs')` — same as today. The memory subsystem already takes `runsRoot` from `MemoryCtx` (`packages/cambium-runner/src/memory/path.ts:7`); this work just lifts the hardcode at `runner.ts:532` into the option.
- **`sessionId` precedence:** `opts.sessionId` > `process.env.CAMBIUM_SESSION_ID` > auto-generated. Same precedence as today; just adds the explicit-option layer at the top.
- **No CLI shape exposed.** The CLI keeps its own argv parsing. `runGen` does not accept `argv` or anything that smells like a CLI. The CLI is a thin caller of `runGen`, not the other way around.

**Out of v0:** streaming progress callbacks, hot-reload, partial schema overrides. File separately when there's a driver.

### 3. `runsRoot` and memory-bucket location

**Decision:** Default to `join(cwd(), 'runs')`. Caller can override per-call. The memory subsystem already plumbs `runsRoot` through `MemoryCtx`, so the only change is at `runner.ts:532`.

Engine-mode hosts will typically pass `runsRoot: path.join(import.meta.dirname, '../runs')` or similar to keep run artifacts adjacent to the engine folder, but this is convention, not requirement.

**Multi-tenant note:** the existing memory key validation (RED-215, `packages/cambium-runner/src/memory/keys.ts`) restricts segments to `/^[a-zA-Z0-9_\-]+$/`. That guard is still the only thing standing between an attacker-controlled `runsRoot` and a `..` traversal — engine-mode hosts that take `runsRoot` from untrusted input are responsible for sanitising it themselves. The runner won't second-guess paths the embedder chose.

### 4. Search-path discovery: co-located first, app layout fallback

**Decision:** Add a "look next to the gen first" rule to the existing `_cambium_*_search_dirs` methods in `runtime.rb` (lines 946–967). The current two-dir search (gen's package's `app/<type>/`, then `packages/cambium/app/<type>/`) becomes a three-dir search with the gen's *own directory* prepended.

When a sentinel (decision 5) is present in the gen's directory, the walk-up steps are *suppressed* — search stops at the engine boundary. This prevents the runtime from reaching back into the host project and picking up an unrelated `cambium/policies/` or `app/policies/` that happens to exist for other reasons.

```ruby
# Sketch — actual edit lives in runtime.rb under RED-220 impl ticket.
def _cambium_policy_search_dirs
  dirs = []
  if (src = Cambium::CompilerState.current_source_file)
    gen_dir = File.dirname(File.expand_path(src))     # NEW: next to the gen
    dirs << gen_dir
    pkg_dir = File.dirname(gen_dir)                    # existing: app/policies/
    dirs << File.join(pkg_dir, 'policies')
  end
  dirs << File.join('packages', 'cambium', 'app', 'policies')
  dirs.uniq
end
```

**Why this works for both modes without conditionals:**

- App mode: a gen at `packages/cambium/app/gens/foo.cmb.rb` looks for `summarizer.policy.rb` in `app/gens/` (not there), then `app/policies/` (found). Same outcome as today.
- Engine mode: a gen at `cambium/summarizer/summarizer.cmb.rb` looks for `summarizer.policy.rb` next to itself (found). The `app/policies/` dir doesn't exist; the `packages/cambium/...` fallback also doesn't exist; both are silently skipped.

The same change applies symmetrically to `_cambium_memory_pool_search_dirs`. If a future "system prompt search" or "tool search" needs the same treatment, copy the pattern — three dirs, gen-local first.

**Filename convention in engine mode:** `<name>.policy.rb` and `<name>.pool.rb` files live directly in the gen folder, not under a sub-`policies/` or `memory_pools/` directory. The "one folder per gen" principle wins over the type-based grouping that app mode uses for scale. If a single engine folder grows enough policy/pool files to need grouping, it has probably outgrown engine mode anyway.

### 5. Engine-folder sentinel + scaffolder mode detection

**Decision:** Every engine folder contains a `cambium.engine.json` sentinel. Its presence is the single source of truth for "this is an engine folder, not part of an app-mode workspace."

Minimal v0 contents:

```json
{
  "name": "summarizer",
  "version": "0.1.0",
  "createdBy": "cambium new engine"
}
```

Fields can be added later (entry method, IR path, schemas path) when the manifest needs to be load-bearing for tooling. v0 is a marker.

**Scaffolder behaviour, by context:**

| Invocation context | Behaviour |
| --- | --- |
| Cwd is inside an engine folder (sentinel found at cwd or ancestor up to first `package.json`) | Drop file as a *sibling* of the gen. Refuse to create `app/<type>/` subdirectories. |
| Cwd is inside an app-mode workspace (`Genfile.toml` or `packages/cambium/` ancestor) | Use the existing `app/<type>/<name>` layout. |
| Neither | Error: `"no Cambium context detected in this directory or its ancestors. Run 'cambium new engine <Name>' to start an engine, or run from inside packages/cambium/."` |

This is enforceable: the scaffolder runs the detection on every `cambium new <thing>` call, picks one mode, and never silently guesses. The historical failure where the assistant created `cambium/summarizer/app/policies/foo.policy.rb` becomes impossible via the scaffolder; only hand-edits could still produce it, and the runtime sentinel-aware search (decision 4) would silently ignore them, which surfaces the misplacement at test time rather than letting it become load-bearing.

**Scaffold-emitted `CLAUDE.md` inside the engine folder:**

```markdown
# Cambium engine folder — read this first

You are inside a Cambium engine folder (marked by `cambium.engine.json`). This is NOT
an app-mode workspace. The conventions are different:

- Tools, policies, systems, and memory pools live as **siblings** of the gen file.
  Filenames: `<name>.tool.{ts,json}`, `<name>.policy.rb`, `<name>.system.md`, `<name>.pool.rb`.
- Do **not** create `app/`, `app/tools/`, `app/policies/`, etc. subdirectories. The runtime
  will not find files placed there, and the layout is wrong for engine mode.
- Use `cambium new tool <Name>` (and the equivalents for policy/system/pool/schema)
  rather than writing files by hand. The scaffolder knows it is in engine mode and
  will place files correctly.
- The IR (`*.ir.json`) and the typed wrapper (`index.ts`) are generated. Re-run
  `cambium compile` after editing the gen.
```

This file is checked in. Future Claude sessions opening the host project see it the moment they enter the engine folder. It costs nothing and prevents the exact failure that motivated this design note.

The folder ships with `summarizer.cmb.rb` *and* `summarizer.ir.json`. The host runtime only needs the IR. Ruby is required to *modify* the gen and re-emit the IR.

**Implications:**

- `@cambium/runner` has no Ruby dependency. Pure Node/TS package.
- `cambium compile` is a Ruby-requiring dev tool. It's part of the `cambium` gem (or a Node wrapper that shells out to Ruby), not part of `@cambium/runner`.
- A host without Ruby installed can still import and run the engine. Editing the gen on a Ruby-equipped machine is a CI step or a contributor responsibility.
- A future "Docker-based `cambium compile`" path is a reasonable escape hatch for shops that want zero Ruby on their dev machines, but it is *not* a v0 concern. File separately if a concrete need surfaces.

The honest framing for engine-mode docs: "you need Ruby to author and recompile gens; you don't need Ruby to run the host app." This is the same shape as protobuf — `protoc` is a build dep, the generated code runs anywhere.

---

## The five impl pieces (and what's now pre-decided)

The RED-220 ticket lists five follow-up implementation pieces. With the decisions above pinned, each becomes a tractable ticket:

1. **Publish `@cambium/runner` as an npm package.** *(Package boundary shipped in RED-242. Programmatic `runGen` API + npm publish pending RED-243.)*
   - Pre-decided: API surface (RunGenOptions / GenResult above).
   - Resolved by RED-242: package boundary is `packages/cambium-runner/`. Everything under `packages/cambium-runner/src/` is part of the public package — `runner.ts`, `step-handlers.ts`, `correctors/`, `memory/`, `tools/` infrastructure, `triggers.ts`, `signals.ts`, `compound.ts`, `enrich.ts`, `schema-describe.ts`, `actions/`, `builtin-tools/`, `builtin-actions/`, `providers/`, `budget.ts`, `inline-tool-calls.ts`, `golden.ts`. Test files (`*.test.ts`) ship in the repo for now but will be excluded from the published artifact when RED-243 wires the schema-injection API and we cut a real `0.1.0`.

2. **`cambium compile <file.cmb.rb> -o <ir.json>` subcommand.**
   - Pre-decided: just factor IR emission out of `cambium run`'s side-effect into a first-class subcommand. No design questions.

3. **Relax Ruby-side discovery paths in `runtime.rb`.**
   - Pre-decided: see the sketch under "Search-path discovery" above. Add gen-local dir as first entry in both `_cambium_*_search_dirs` methods.

4. **Schema co-location wiring.** *(Shipped in RED-243.)*
   - Pre-decided: caller-injected schemas (above). Implementation is one edit: `runner.ts:430` becomes a parameter read instead of a file import. The app-mode CLI gets a one-line shim that imports `contracts.ts` and passes it in, preserving today's behaviour.
   - Resolved: `runGen(opts)` is exported from `@cambium/runner` (`packages/cambium-runner/src/index.ts`), takes `opts.schemas` (caller-injected), and returns a structured `RunGenResult` (`{ ok, output, trace, runId, schemaId, ir, errorMessage? }`). The runner no longer imports any contracts file by path. The CLI's `main()` reads argv, imports `packages/cambium/src/contracts.ts`, calls `runGen`, then handles file writes and exit code. Engine-mode callers (RED-246) will pass a sibling `schemas.ts` instead.

5. **`cambium new engine <Name>` scaffolder + sentinel-aware mode detection.**
   - Pre-decided: folder shape (above), sentinel format (`cambium.engine.json`), CLAUDE.md emitted into the folder, the three-row context-detection table for `cambium new <thing>`.
   - Engineering note: the mode-detection logic is shared across every `cambium new` subcommand, not just `cambium new engine`. Factor it once.

The generated `index.ts` template:

```ts
import { runGen } from '@cambium/runner';
import * as schemas from './schemas';
import ir from './summarizer.ir.json' with { type: 'json' };
import type { Static } from '@sinclair/typebox';

export type SummarizerInput = { /* hand-edited or generated from method signature */ };
export type SummarizerOutput = Static<typeof schemas.DocumentSummary>;

export interface SummarizerOptions {
  runsRoot?: string;
  env?: Record<string, string>;
}

export async function summarize(
  input: SummarizerInput,
  opts: SummarizerOptions = {},
): Promise<SummarizerOutput> {
  const result = await runGen(ir as never, { input, schemas, ...opts });
  return result.output as SummarizerOutput;
}
```

The function name (`summarize`) and method-signature input type are derived from the gen's `def <method>(<arg>)` declaration. The output type comes from `returns <SchemaName>`. Both should be regenerated when the gen changes; the file is marked as generated and not hand-edited.

---

## Acceptance for this design note

- [x] The two modes are named and described.
- [x] The `app/app` failure mode from the first real attempt is documented and the fix is specified.
- [x] Schema-resolution contract is settled (caller-injected).
- [x] `runGen` API surface is specified.
- [x] `runsRoot` is settled (configurable, default `cwd()/runs`).
- [x] Search-path relaxation is specified, including sentinel-aware suppression.
- [x] Engine-folder sentinel + scaffolder mode-detection is specified.
- [x] Ruby-as-dev-dep position is stated.
- [ ] Each impl piece has a Linear ticket filed against it.
- [ ] First proof-of-concept exists: a fresh Node project that is *not* the Cambium monorepo, with one engine-mode gen folder and a typed `import` calling into `@cambium/runner` end-to-end. The POC explicitly re-runs the first-attempt scenario to confirm the `app/app` trap no longer reproduces.

The last two items are tracked under RED-220 itself; this note is the design artefact the ticket calls for in its first acceptance bullet.

---

## Out of scope (re-stated for the design note)

The RED-220 ticket lists these as non-goals; they remain non-goals here:

- **Sidecar / Docker / non-Node hosts.** Engine mode is the Node/TS embedding case. A polyglot or all-Cambium-in-a-container deployment is a different problem.
- **Cross-language client SDKs.** Same deferral.
- **IR versioning / forward-compat spec.** `@cambium/runner` is semver-pinned by callers; that's enough until there is a reason to do more.
- **Multi-tenancy, sidecar state management.** Not relevant to embedded-in-Node.

---

## See also

- [[D - Packages & Workspaces (Scale-Invariant)]] — the app-mode workspace convention this note layers engine mode on top of.
- [[C - IR (Intermediate Representation)]] — the IR is the boundary that lets engine mode work without coupling Ruby and TS at runtime.
- [[C - Runner (TS runtime)]] — what `@cambium/runner` packages.
- [[P - Memory]] — `runsRoot` plumbing precedent.
- [[P - Policy Packs (RED-214)]] — search-path precedent for the relax in (4).
