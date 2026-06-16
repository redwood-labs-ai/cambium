// Public entry point for @redwood-labs/cambium-runner.
//
// RED-242 established the package boundary. RED-243 exposes `runGen` —
// the programmatic library entry point — with caller-injected schemas
// (no hardcoded `import()` of any contracts file from a fixed path).
//
// App mode (the in-tree `cambium run` CLI) imports
// `packages/cambium/src/contracts.ts` and passes it as `schemas`.
// Engine mode (RED-220) will pass a sibling `schemas.ts` instead.

export { runGen } from './runner.js';
export type { IR, RunGenOptions, RunGenResult } from './runner.js';

// RED-306: CLI-equivalent in-process entry point. Wraps schema
// discovery + runGen + artifact writes. The `cambium` CLI imports this
// directly (Option B: in-process, no subprocess). Engine-mode hosts
// continue to call runGen directly with their own schemas.
export { runGenFromIr } from './runner.js';
export type { RunGenFromIrOptions, RunGenFromIrResult } from './runner.js';

// RED-312: replay loader. Resolves a prior run's artifacts into the
// { ir, candidate, parentRunId } triple that runGenFromIr resumes from.
export { resolveReplay, resolveRunDir } from './replay.js';
export type { ResolvedReplay, ResolvedGenReplay, ResolvedPipelineReplay } from './replay.js';

// RED-381 Phase B: Pipeline runtime. Mirrors runGenFromIr's shape but
// for Pipeline IRs. CLI dispatches between gen + pipeline IRs based on
// `ir.kind`. Engine-mode pipelines defer.
export { runPipelineFromIr } from './pipeline.js';
export type { RunPipelineFromIrOptions, RunPipelineFromIrResult } from './pipeline.js';

// RED-275 app-corrector plugin surface. External apps scaffold
// `app/correctors/<name>.corrector.ts` and import these types to get
// the correct export signature.
export type {
  CorrectorFn,
  CorrectorResult,
  CorrectorIssue,
} from './correctors/types.js';

// RED-209 tool-plugin surface. External apps scaffold
// `app/tools/<name>.tool.ts` and import ToolContext for the ctx.fetch
// SSRF guard + permissions plumbing.
export type { ToolContext } from './tools/tool-context.js';

// RED-393 provider-plugin surface. External apps scaffold
// `app/providers/<name>.ts` and `export default` a CambiumProvider built
// via one of these factories (`openaiCompatible` / `anthropicCompatible`
// for the common base-URL+auth swap; `defineProvider` for full control).
// The basename becomes the model-id prefix.
export { openaiCompatible, anthropicCompatible } from './providers/factories.js';
export type { OpenAICompatibleConfig, AnthropicCompatibleConfig } from './providers/factories.js';
export { defineProvider, normalizeModelName } from './providers/registry.js';
export type { ModelNameTransform } from './providers/registry.js';
// SSRF/egress posture helper: app providers fetch operator-supplied base
// URLs. `validateProviderBaseUrl` is the same guard the built-ins use
// (blocks private/metadata ranges unless CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL).
export { validateProviderBaseUrl } from './providers/base-url-validator.js';
// RED-421 (DEC-A/D): typed provider errors — part of the provider-author
// contract. A custom provider throws `new ProviderHttpError(status, msg)` to
// participate in transient-failure fallback; a plain `Error` is deterministic.
// `ProviderConnectionError` (DEC-D) is the typed signal for connection-level
// failures (no HTTP response); built-in providers use it internally so that
// ECONNREFUSED / DNS / TLS failures are transient. Custom providers may use it
// too; plain `Error` / `TypeError` remain deterministic (DEC-A unchanged).
export { ProviderHttpError, ProviderConnectionError } from './providers/types.js';
export type {
  CambiumProvider,
  GenerateTextOpts,
  GenerateResult,
  GenerateWithToolsOpts,
  GenerateWithToolsResult,
} from './providers/types.js';

// RED-360 serve mode: long-lived runner over HTTP. Exposed so the CLI
// (`cambium serve`) and engine-mode hosts that want to embed the server
// have the same entry point. Wire format is locked at v1 — see
// `docs/GenDSL Docs/C - Serve Mode.md`.
export { runServe } from './serve/serve.js';
export type {
  RunServeOptions,
  RunServeHandle,
  RunServeAddress,
  CompileBareFn,
} from './serve/serve.js';
export { parseBind, isLoopback } from './serve/bind.js';
export type { BindTarget, ParseBindOptions } from './serve/bind.js';

// RED-313 `cambium inspect`: local read-only trace viewer. `runInspect` starts
// the HTTP server; `projectTrace` / `resolveRunsDir` are exposed for hosts
// (and tests) that want the pure projection or runs-dir resolution directly.
export { runInspect, DEFAULT_PUBLIC_DIR } from './inspect/server.js';
export type { RunInspectOptions, InspectHandle } from './inspect/server.js';
export { resolveRunsDir, listRuns, loadRun, isValidRunId } from './inspect/runs.js';
export { projectTrace, summarizeTrace } from './inspect/projection.js';
export type { GraphModel, GraphNode, GraphEdge, NodeStatus, TraceSummary } from './inspect/projection.js';

// RED-140: golden-test engine — field-level snapshot comparison with
// tolerances and built-in normalizers for dates, numbers, citations, and
// strings. Deterministic via `--mock` / `cambium replay`; no tokens
// consumed on regression runs. See `docs/GenDSL Docs/P - Golden Tests (RED-140).md`.
export {
  goldenTest,
  formatGoldenFailure,
  stripCitations,
  normalizeNumbers,
  normalizeStrings,
  normalizeDates,
} from './golden.js';
export type { DiffEntry, GoldenTestOptions, GoldenTestResult } from './golden.js';
