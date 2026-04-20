// Public entry point for @cambium/runner.
//
// RED-242 established the package boundary. RED-243 exposes `runGen` —
// the programmatic library entry point — with caller-injected schemas
// (no hardcoded `import()` of any contracts file from a fixed path).
//
// App mode (the in-tree `cambium run` CLI) imports
// `packages/cambium/src/contracts.ts` and passes it as `schemas`.
// Engine mode (RED-220) will pass a sibling `schemas.ts` instead.

export { runGen } from './runner.js';
export type { RunGenOptions, RunGenResult } from './runner.js';

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
