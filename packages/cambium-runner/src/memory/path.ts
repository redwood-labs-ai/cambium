import { join } from 'node:path';
import type { MemoryDecl, MemoryRunContext } from './types.js';
import { validateSafeSegment } from './keys.js';

/**
 * RED-215 phase 3: resolve a memory decl to a concrete bucket file path.
 *
 * Shape: `<runsRoot>/memory/<scope>/<key>/<name>.sqlite`
 *
 * Key resolution:
 *   :session scope       → key = the run's session id
 *   :global scope + no keyed_by   → key = '_'
 *   <other> with keyed_by <name>  → key = ctx.keys[<name>], missing = clear error
 *
 * The `name` and `scope` segments come straight from the IR. Named pools
 * are regex-checked at compile time, but a free-form `memory <name>,
 * scope:` decl never was — and an IR can now arrive from disk (#195), so
 * both are validated HERE, regardless of origin, with the same guard
 * `--memory-key` values get (`validateSafeSegment`: [a-zA-Z0-9_\\-], 128
 * max). Without it a decl name like `../../x` was an arbitrary-directory
 * write (security gate, #195 F2).
 */
export function resolveBucketPath(decl: MemoryDecl, ctx: MemoryRunContext): string {
  validateSafeSegment('name', decl.name, 'memory decl');
  validateSafeSegment('scope', decl.scope, `memory '${decl.name}'`);
  const scopeSeg = decl.scope;
  let keySeg: string;

  if (decl.scope === 'session') {
    keySeg = ctx.sessionId;
  } else if (decl.scope === 'global' && !decl.keyed_by) {
    keySeg = '_';
  } else if (decl.scope === 'schedule') {
    // RED-305: schedule-scoped bucket keyed by the schedule id. Runtime
    // must be a scheduled fire — the runner enforces this with a clear
    // error before reaching path resolution, but guard here too so a
    // direct runGen caller that forgot to set firedBy gets a clean
    // failure mode rather than a cryptic missing-key.
    if (!ctx.scheduleId) {
      throw new Error(
        `memory '${decl.name}' scope: :schedule requires a scheduled fire. ` +
        `Pass --fired-by schedule:<id> (or set CAMBIUM_FIRED_BY) on the invocation.`,
      );
    }
    keySeg = ctx.scheduleId;
  } else if (decl.scope === 'pipeline_run') {
    // RED-381 Phase E: pipeline-shared bucket keyed by the pipeline's
    // run id. All sub-gens of the same pipeline run see the same
    // bucket; sub-gens of different pipeline runs see different
    // buckets. ctx.pipelineRunId is set by runPipelineFromIr on every
    // sub-gen invocation. A gen with scope: :pipeline_run invoked
    // OUTSIDE a pipeline (direct runGen call from a host that didn't
    // set pipelineRunId) gets a clear error rather than silently
    // writing to an unkeyed bucket.
    if (!ctx.pipelineRunId) {
      throw new Error(
        `memory '${decl.name}' scope: :pipeline_run requires a pipeline-driven invocation. ` +
        `Direct runGen callers must pass opts.pipelineRunId; sub-gens dispatched by ` +
        `runPipelineFromIr get this automatically. See N - Orchestration Layer § Pipeline memory.`,
      );
    }
    keySeg = ctx.pipelineRunId;
  } else {
    const keyName = decl.keyed_by;
    if (!keyName) {
      throw new Error(
        `memory '${decl.name}' scope: :${decl.scope} has no keyed_by — ` +
          'named-pool and non-session global memories must declare keyed_by on the pool or decl.',
      );
    }
    const keyValue = ctx.keys[keyName];
    if (!keyValue) {
      throw new Error(
        `memory '${decl.name}' scope: :${decl.scope} needs --memory-key ${keyName}=<value>. ` +
          `No value was provided at run time.`,
      );
    }
    keySeg = keyValue;
  }

  return join(ctx.runsRoot, 'memory', scopeSeg, keySeg, `${decl.name}.sqlite`);
}
