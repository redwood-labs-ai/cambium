# Note: Visual Trace Renderer (`cambium inspect`)

**Doc ID:** gen-dsl/note/visual-trace-renderer
**Status:** read-only v1 shipped (RED-313). Replay-from-node is a follow-up (RED-406).

## What it is

`cambium inspect` starts a **local, read-only** browser viewer over a workspace's
`runs/` directory. The trace is already a structured execution graph; the viewer
is just a different projection of the same `trace.json` the CLI already writes —
no new instrumentation, no telemetry pipeline, no build step.

```bash
cambium inspect                      # serve on http://127.0.0.1:3210, open browser
cambium inspect <run-id>             # deep-link straight to a run
cambium inspect --port 8080          # custom port (or CAMBIUM_INSPECT_PORT)
cambium inspect --runs-dir <path>    # explicit runs/ dir
cambium inspect --no-open            # don't auto-open the browser
```

It pairs with `cambium replay` (RED-312): replay is **temporal** navigation of a
trace, the inspector is **spatial** representation of it.

## Architecture

Three layers, all in `packages/cambium-runner/src/inspect/`:

1. **`projection.ts` — `projectTrace(trace) → GraphModel`** (pure, deterministic).
   The brains. Turns a `trace.json` into renderer-agnostic nodes + typed edges.
   - **gen** trace → `steps[]` chained by `sequence` edges.
   - **pipeline** trace (`type: 'PipelineRun'`) → `operators[]`, recursing into
     the nesting: `PipelineStep.trace` (a full sub-gen trace), `PipelineFanOut.
     branches[]` (a sub-gen each), `PipelineBranchOn.trace.operators[]`
     (recursive). Every node carries `parentId` + `depth` so the renderer can
     draw nested lanes.
   - Node `status`: `ok` / `error` (`ok:false`) / `warn` (`CorrectAcceptedWithErrors`,
     `meta.failed`, soft errors) / `skipped` / `info`. Edge kinds: `sequence`,
     `nested`, `fanout`, `branch`, `lineage`. `parent_run_id` → `model.lineage`.
   - **Source of truth is the trace** (what ran), never the IR (the plan).
2. **`server.ts` — `runInspect()`** (plain `node:http`, zero deps, localhost-only).
   - `GET /api/runs` → newest-first run summaries.
   - `GET /api/runs/:id` → the projected `GraphModel` + the run's `output.json`.
   - `GET /api/events` → SSE; a debounced `fs.watch` on `runs/` pushes
     `runs-changed` so the UI refreshes when a new run lands.
   - guarded static serving of `public/`.
3. **`public/index.html` — vanilla viewer** (no framework, no bundler). Runs list +
   SVG execution graph (vertical nested lanes, orthogonal elbow connectors,
   status-colored boxes) + click→side-panel (meta / output). Ships as a static
   asset inside the published CLI tarball.

## Invariants / guards

- **Localhost-only, no auth** — bind defaults to `127.0.0.1`. Share via SSH
  port-forward, not a remote bind. The viewer only *reads* `runs/` files.
- **Untrusted inputs are the `:id` path segment and asset paths.** Run ids are
  validated `/^run_[A-Za-z0-9_T-]{1,128}$/` and realpath-escape-checked before
  any `path.join` (same RED-214/275 stance as pack/pool/corrector loaders);
  static asset paths are normalized and confined to `public/`.
- **Runs are addressed by directory name**, not the trace's embedded `run_id`
  (normally equal, but the directory is authoritative for lookup).
- **`runs/` resolution** mirrors the runner: `--runs-dir` override → `<engineDir>/
  runs` (engine mode) → `<cwd>/runs`. Operator contract: cwd is the workspace or
  an ancestor. Multi-root aggregation is out of scope for v1.

## Out of scope (v1)

- **Replay-from-node button** — splits to RED-406; it turns the viewer into an
  *exec* surface (a browser request triggers `cambium replay`), a different risk
  class that needs its own security pass.
- Hosted / multi-user / auth, live in-flight run streaming, two-run diff view,
  telemetry export (the `log` primitive already owns trace fan-out).

## Related

- [[P - cambium replay]] — temporal navigation of a trace; the inspector is the spatial view.
- [[N - Orchestration Layer]] — pipeline trace step types the projection renders.
- [[C - Runner (TS runtime)]] — where `runs/<id>/trace.json` is written.
