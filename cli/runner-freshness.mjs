// Stale-`dist/` guard for the in-process runner import.
//
// `cambium run` (and replay/serve/inspect/scaffold-tool) load the runner
// through `import('@redwood-labs/cambium-runner')`, whose package `main` is
// `./dist/index.js`. In a source checkout that means the CLI executes the
// LAST BUILD, not the working tree — editing `packages/cambium-runner/src`
// and re-running the CLI silently exercises the old code, with no warning
// and no signal in the output.
//
// The failure is worse than "dist is a bit behind". `npm test` is
// `npm run build && vitest run`, so dist is rebuilt from whatever tree was
// checked out at the last test run. A `git stash` / test / `stash pop`
// comparison — or a rebase, or a bisect — leaves dist holding a DIFFERENT
// BRANCH's code while the working tree shows yours. That reads as "my fix
// didn't work" rather than "you're running someone else's build".
//
// So: in a source checkout, refuse to run against a stale dist. Two signals,
// with different jobs:
//
//   - mtime comparison DETECTS staleness (newest build-relevant src file vs
//     newest emitted dist file). tsconfig.build.json sets no `incremental`,
//     so every build re-emits and the newest-vs-newest comparison is sound.
//   - `dist/build-info.json` (stamped by scripts/copy-assets.mjs) EXPLAINS
//     it — naming the branch and commit dist was built from is the line that
//     actually saves the round trip.
//
// Hard error, not a warning: a warning prints above the run output and
// scrolls past exactly when you most need to see it.
//
// Installed users never reach any of this — the published package ships
// only `dist` + README (see the runner's `files`), so `isSourceCheckout()`
// is false and the guard is a no-op.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(CLI_DIR, '..', 'packages', 'cambium-runner');

/** Paths derived from a runner package root. Parameterized so tests can
 *  point the check at a synthetic tree instead of mutating the real one —
 *  touching the real src/ mid-suite would trip this guard for every later
 *  test that shells out to the CLI. */
function layout(runnerRoot) {
  const distDir = join(runnerRoot, 'dist');
  return {
    runnerRoot,
    srcDir: join(runnerRoot, 'src'),
    distDir,
    buildInfo: join(distDir, 'build-info.json'),
    tsconfig: join(runnerRoot, 'tsconfig.build.json'),
  };
}

/** Escape hatch, for the rare case where you know dist is what you want. */
const SKIP_ENV = 'CAMBIUM_SKIP_BUILD_CHECK';

/**
 * True only in a source checkout of the cambium monorepo. The published
 * tarball has no `src/` and no `tsconfig.build.json`, so end users are
 * never gated.
 */
function isSourceCheckout(paths) {
  return existsSync(paths.srcDir) && existsSync(paths.tsconfig);
}

/**
 * Files whose edits change what `npm run build` emits. Mirrors
 * tsconfig.build.json's include/exclude plus copy-assets.mjs's asset set —
 * if those change, change this too, or the guard drifts into false
 * negatives (missed staleness) or false positives (editing a runner unit
 * test would demand a rebuild it doesn't need).
 */
function isBuildInput(path) {
  if (path.includes(`${sep}__fixtures__${sep}`)) return false;
  if (path.endsWith('.test.ts') || path.endsWith('.regression.test.ts')) return false;
  return (
    path.endsWith('.ts') ||
    path.endsWith('.mjs') ||
    (path.endsWith('.json') && !path.endsWith('tsconfig.json') && !path.endsWith('package.json'))
  );
}

function isBuildOutput(path) {
  return path.endsWith('.js');
}

/** Newest mtime under `dir` among files passing `filter`. */
function newest(dir, filter) {
  let mtime = 0;
  let path = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — treat as empty rather than crash the CLI
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
        continue;
      }
      if (!filter(full)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue; // vanished mid-walk
      }
      if (stat.mtimeMs > mtime) {
        mtime = stat.mtimeMs;
        path = full;
      }
    }
  }
  return { mtime, path };
}

function readBuildInfo(paths) {
  try {
    return JSON.parse(readFileSync(paths.buildInfo, 'utf8'));
  } catch {
    return null; // pre-guard build, or a tarball without the stamp
  }
}

/**
 * Describes what dist was built from, when the stamp is available and
 * disagrees with the current checkout. Returns null when there's nothing
 * useful to add, so the caller can omit the line entirely.
 */
function provenanceLine(info) {
  if (!info) return null;
  const builtFrom = [info.branch, info.head].filter(Boolean).join('@');
  if (!builtFrom) return null;
  const dirty = info.dirty ? ' (with uncommitted changes)' : '';
  return `  dist/ was built from ${builtFrom}${dirty}`;
}

/**
 * Returns a ready-to-print explanation when the runner's `dist/` is missing
 * or older than its `src/`, else null. Pure — no printing, no exit — so the
 * decision can be tested without spawning a CLI.
 *
 * No-op (null) outside a source checkout, or when CAMBIUM_SKIP_BUILD_CHECK
 * is set.
 */
export function checkRunnerFreshness(runnerRoot = RUNNER_ROOT) {
  if (process.env[SKIP_ENV]) return null;
  const paths = layout(runnerRoot);
  if (!isSourceCheckout(paths)) return null;

  const lines = [];

  if (!existsSync(paths.distDir)) {
    lines.push('The Cambium runner has not been built.');
  } else {
    const src = newest(paths.srcDir, isBuildInput);
    const dist = newest(paths.distDir, isBuildOutput);

    if (dist.mtime === 0) {
      lines.push('The Cambium runner has not been built (dist/ contains no emitted JS).');
    } else if (src.mtime > dist.mtime) {
      lines.push(
        'The Cambium runner is stale — this would run the last build, not your working tree.',
      );
      const info = provenanceLine(readBuildInfo(paths));
      if (info) lines.push(info);
      if (src.path) lines.push(`  newer source: ${relative(runnerRoot, src.path)}`);
    } else {
      return null; // fresh
    }
  }

  lines.push('');
  lines.push('  Fix: npm run build');
  lines.push(`  Override: ${SKIP_ENV}=1 (runs the existing dist/ as-is)`);
  return lines.join('\n');
}

/**
 * Prints the staleness explanation and exits non-zero, or returns cleanly.
 *
 * Exits rather than throwing: a thrown Error prints a stack trace whose
 * frames are pure noise here (the guard's own call chain), and which pushes
 * the actionable line off the top of a short terminal. This is a CLI
 * precondition failure, so it gets CLI treatment — same as `usage()`.
 */
export function assertRunnerFresh() {
  const message = checkRunnerFreshness();
  if (message === null) return;
  console.error(`\ncambium: ${message}\n`);
  process.exit(1);
}

/**
 * The only sanctioned way for the CLI to load the runner — the freshness
 * check and the import are bound together here so a new call site cannot
 * bypass the guard by importing the package directly.
 */
export async function loadRunner() {
  assertRunnerFresh();
  return import('@redwood-labs/cambium-runner');
}
