// ── Replay loader (RED-312) ────────────────────────────────────────────
//
// Resolves a prior run's artifacts into the inputs `runGenFromIr` needs
// to resume execution from a post-Generate checkpoint:
//
//   { ir, candidate, parentRunId }
//
// The trace IS the savepoint file. This module reads it; the runner
// re-executes the cheap deterministic tail (validate → correct → repair
// → grounding) against `candidate`, skipping the expensive Generate that
// already ran. See `runGen({ resumeCandidate })`.
//
// Phase 1 (this commit) covers gen-level runs. Pipeline runs
// (`ir.kind === 'Pipeline'`) are refused with a clear pointer — operator-
// level resume is the RED-385 piece B follow-up.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** A gen-level replay: resume a single gen's post-Generate tail from a
 *  candidate output. */
export interface ResolvedGenReplay {
  kind: 'gen';
  /** The prior run's IR, loaded from `<runDir>/ir.json`. */
  ir: any;
  /** The candidate output to resume from. */
  candidate: unknown;
  /** The source run's id, threaded into the replay trace as parent_run_id. */
  parentRunId: string;
  /** Checkpoint origin for trace annotation: 'output' or a step type. */
  fromStep: string;
  /** Absolute path to the resolved source run directory. */
  runDir: string;
}

/** A pipeline replay: resume the operator DAG from the first incomplete
 *  operator (or an explicit `--from-op`), reusing recorded upstream
 *  outputs (RED-385 Phase B). The runtime (`runPipelineFromIr`) does the
 *  resume-index computation + stepResults rehydration; the loader just
 *  supplies the prior trace. */
export interface ResolvedPipelineReplay {
  kind: 'pipeline';
  ir: any;
  /** The prior run's full trace (its `operators[]` carry the recorded
   *  outputs Phase A persisted). */
  priorTrace: any;
  parentRunId: string;
  /** Explicit resume operator id (`--from-op`), or null to default to the
   *  first incomplete operator. */
  fromOp: string | null;
  runDir: string;
}

export type ResolvedReplay = ResolvedGenReplay | ResolvedPipelineReplay;

/**
 * Resolve a `cambium replay` reference into the run directory.
 *
 * Accepts either an explicit path (`runs/run_2026...`, an absolute dir,
 * or any ref containing a path separator / pointing at an existing dir)
 * or a bare run-id, which is looked up under `<cwd>/runs/<id>`.
 */
export function resolveRunDir(runRef: string, cwd = process.cwd()): string {
  const ref = runRef.replace(/\/+$/, ''); // strip trailing slashes
  if (!ref) throw new Error('replay: empty run reference');

  // Path form: absolute, contains a separator, or names an existing dir.
  // The path form is intentionally unrestricted — it deliberately resolves
  // outside `<cwd>/runs/` because workspace-layout runs live at
  // `<workspace>/packages/cambium/runs/` while cwd is the repo root, and a
  // user may point at any run dir they own. This is the same trust model as
  // `cambium run <path-to-ir-or-gen>`: the operator loads their own local
  // artifacts. We do NOT apply a workspace-escape guard here (it would break
  // absolute paths and the documented path form); a remote/untrusted caller
  // must never pass an attacker-controlled ref to this function.
  const looksLikePath = isAbsolute(ref) || ref.includes('/') || existsSync(ref);
  const candidates = looksLikePath
    ? [resolve(cwd, ref)]
    : [join(cwd, 'runs', ref)];

  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  throw new Error(
    `replay: run not found for "${runRef}". Looked at: ${candidates.join(', ')}. ` +
      `Pass a run-id (resolved under <cwd>/runs/) or a path to the run directory.`,
  );
}

function readJson(path: string, label: string): any {
  if (!existsSync(path)) {
    throw new Error(`replay: missing ${label} at ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e: any) {
    throw new Error(`replay: failed to parse ${label} at ${path}: ${e?.message ?? e}`);
  }
}

/**
 * Pick the candidate to resume from.
 *
 * Default (`fromStep` unset): the run's `output.json` — the complete
 * post-Generate artifact.
 *
 * `--from-step <type>`: the recorded `output` of the last trace step of
 * that type. Errors clearly if no such step exists or it recorded no
 * output value (e.g. `Generate`, which stores only a truncated preview —
 * resume from `output.json` instead).
 */
function resolveCandidate(
  outputJson: unknown,
  trace: any,
  fromStep: string | undefined,
): { candidate: unknown; fromStep: string } {
  if (!fromStep) return { candidate: outputJson, fromStep: 'output' };

  const steps: any[] = Array.isArray(trace?.steps) ? trace.steps : [];
  const matches = steps.filter((s) => s?.type === fromStep);
  if (matches.length === 0) {
    const present = [...new Set(steps.map((s) => s?.type).filter(Boolean))].join(', ');
    throw new Error(
      `replay: no step of type "${fromStep}" in the target trace. ` +
        `Present step types: [${present}]. Omit --from-step to resume from output.json.`,
    );
  }
  // Last instance wins — mirrors "whatever that step last produced"
  // (repair loops can run a step type more than once).
  const last = matches[matches.length - 1];
  if (!('output' in last) || last.output === undefined) {
    throw new Error(
      `replay: step "${fromStep}" recorded no resumable output value. ` +
        `Only steps that persist their output (e.g. Correct, ToolCall) can be a ` +
        `--from-step checkpoint; resume from output.json (omit --from-step) instead.`,
    );
  }
  return { candidate: last.output, fromStep };
}

/**
 * Load a prior run and resolve the checkpoint. Does NOT execute.
 *
 * Gen runs: the caller applies any `--edit` to `candidate`, then hands the
 * result to `runGenFromIr({ ir, candidate, fromStep, parentRunId })`.
 *
 * Pipeline runs: the caller passes `{ priorTrace, parentRunId, fromOp }` to
 * `runPipelineFromIr({ replay })`, which computes the resume index and
 * rehydrates stepResults from the recorded operator outputs (RED-385 Phase B).
 *
 * `--from-step` is gen-level only; `--from-op` is pipeline-level only.
 * Passing the wrong one for the run kind is a clear error.
 */
export function resolveReplay(opts: {
  runRef: string;
  cwd?: string;
  fromStep?: string;
  fromOp?: string;
}): ResolvedReplay {
  const cwd = opts.cwd ?? process.cwd();
  const runDir = resolveRunDir(opts.runRef, cwd);

  const ir = readJson(join(runDir, 'ir.json'), 'ir.json');
  const tracePath = join(runDir, 'trace.json');
  const trace = existsSync(tracePath) ? readJson(tracePath, 'trace.json') : null;

  // ── Pipeline replay ────────────────────────────────────────────────
  if (ir?.kind === 'Pipeline') {
    if (opts.fromStep) {
      throw new Error(
        `replay: --from-step is gen-level. "${opts.runRef}" is a Pipeline run — ` +
          `use --from-op <operator-id> to choose a resume operator.`,
      );
    }
    if (!trace) {
      throw new Error(
        `replay: pipeline replay requires trace.json (the operator outputs to ` +
          `rehydrate from), which is missing at ${tracePath}.`,
      );
    }
    if (opts.fromOp) {
      const ids = (ir.operators ?? []).map((o: any) => o.id);
      if (!ids.includes(opts.fromOp)) {
        throw new Error(
          `replay: --from-op "${opts.fromOp}" is not an operator of this pipeline. ` +
            `Operators: [${ids.join(', ')}].`,
        );
      }
    }
    return {
      kind: 'pipeline',
      ir,
      priorTrace: trace,
      parentRunId: trace.run_id ?? basename(runDir),
      fromOp: opts.fromOp ?? null,
      runDir,
    };
  }

  // ── Gen replay ─────────────────────────────────────────────────────
  if (opts.fromOp) {
    throw new Error(
      `replay: --from-op is pipeline-level. "${opts.runRef}" is a gen run — ` +
        `use --from-step <step-type> (or omit it to resume from output.json).`,
    );
  }
  const outputJson = readJson(join(runDir, 'output.json'), 'output.json');
  if (opts.fromStep && !trace) {
    throw new Error(
      `replay: --from-step requires trace.json, which is missing at ${tracePath}.`,
    );
  }
  const { candidate, fromStep } = resolveCandidate(outputJson, trace, opts.fromStep);
  const parentRunId = trace?.run_id ?? basename(runDir);

  return { kind: 'gen', ir, candidate, parentRunId, fromStep, runDir };
}
