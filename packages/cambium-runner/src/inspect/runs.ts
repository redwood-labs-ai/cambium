// RED-313: runs-directory access for `cambium inspect`. Resolves which
// `runs/` dir to read, lists run summaries, and loads a single run's graph
// model. All filesystem access funnels through here with the RED-214/275
// path-traversal guards (the run id comes off an HTTP request and is
// interpolated into a path — it MUST be validated before `join`).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { findEngineDirFromCwd } from '../engine-root.js';
import { projectTrace, summarizeTrace, type GraphModel, type TraceSummary } from './projection.js';

// Run ids the runner emits: `run_YYYYMMDD_HHMMSS_hex` (gen) /
// `run_YYYYMMDDTHHMMSSZ_hex` (pipeline), plus replay children. Restrict to a
// safe charset + length so the id can't escape the runs dir via `..` (which
// `path.join` would silently normalize).
const RUN_ID_RE = /^run_[A-Za-z0-9_T-]{1,128}$/;

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/**
 * Resolve the runs directory. Explicit override wins; otherwise engine mode
 * (`<engineDir>/runs` when cwd sits under a `cambium.engine.json` sentinel);
 * otherwise `<cwd>/runs`. Operator contract: cwd is the workspace (or an
 * ancestor of the engine dir) — same stance as runGenFromIr's cwd fallback.
 * Multi-root aggregation (repo-root runs plus per-package runs dirs) is out of
 * scope for v1.
 */
export function resolveRunsDir(cwd: string, override?: string): string {
  if (override) return resolve(cwd, override);
  const engineDir = findEngineDirFromCwd(cwd);
  return join(engineDir ?? cwd, 'runs');
}

/** Validate `id` and resolve its run dir, returning null if invalid or if the
 *  resolved path escapes `runsDir` (symlink / traversal). */
export function safeRunDir(runsDir: string, id: string): string | null {
  if (!isValidRunId(id)) return null;
  const dir = join(runsDir, id);
  try {
    const realRoot = realpathSync(runsDir);
    const realDir = realpathSync(dir);
    if (realDir !== realRoot && relative(realRoot, realDir).startsWith('..')) return null;
    return dir;
  } catch {
    return null; // dir missing / unreadable
  }
}

function readTrace(dir: string): any | null {
  const file = join(dir, 'trace.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `id` is the run DIRECTORY name — the value the API addresses
 *  (`/api/runs/:id`). `runId` is the trace's embedded `run_id` (normally
 *  identical, but the directory name is authoritative for lookup). */
export type RunListEntry = TraceSummary & { id: string; mtimeMs: number };

/** List run summaries (newest first). A run dir without a parseable
 *  trace.json is skipped (it may be mid-write or replay-less). */
export function listRuns(runsDir: string): RunListEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return []; // no runs dir yet → empty list, not an error
  }
  const out: RunListEntry[] = [];
  for (const name of entries) {
    // safeRunDir applies the id regex AND the realpath escape guard — same
    // defense as loadRun, so a symlinked run dir pointing outside runsDir is
    // skipped here too (no asymmetry between list + load).
    const dir = safeRunDir(runsDir, name);
    if (!dir) continue;
    let mtimeMs = 0;
    try {
      if (!statSync(dir).isDirectory()) continue;
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const trace = readTrace(dir);
    if (!trace) continue;
    out.push({ id: name, ...summarizeTrace(trace), mtimeMs });
  }
  // Sort by started_at when present, else dir mtime — newest first.
  out.sort((a, b) => {
    const at = a.startedAt ? Date.parse(a.startedAt) : a.mtimeMs;
    const bt = b.startedAt ? Date.parse(b.startedAt) : b.mtimeMs;
    return bt - at;
  });
  return out;
}

export type LoadedRun = {
  model: GraphModel;
  /** Parsed output.json when present (the run's final output). */
  output?: unknown;
};

/** Load + project a single run. Returns null for an invalid id, a missing
 *  dir, or an unparseable trace. */
export function loadRun(runsDir: string, id: string): LoadedRun | null {
  const dir = safeRunDir(runsDir, id);
  if (!dir) return null;
  const trace = readTrace(dir);
  if (!trace) return null;
  const model = projectTrace(trace, { includeOutputs: true });
  let output: unknown;
  const outFile = join(dir, 'output.json');
  if (existsSync(outFile)) {
    try {
      output = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch {
      /* leave output undefined */
    }
  }
  return { model, output };
}
