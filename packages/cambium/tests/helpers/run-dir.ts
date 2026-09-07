/** Shared run-directory helpers for CLI-level tests (#224).
 *
 *  Every test that shells out to `cambium run` has to recover the run
 *  directory from the CLI's stderr emit and clean it up afterwards. That
 *  pattern was copied into three files (twelve call sites) rather than
 *  shared, and both halves of it were wrong in the same way everywhere —
 *  which is the reason this module exists at all.
 */
import { rmSync } from 'node:fs';
import { expect } from 'vitest';

/** The emit this parses (runner.ts:2440, pipeline.ts:335):
 *
 *    [cambium] run <id> dir=<runDir> trace=<tracePath>
 *
 *  and, when the run dir could not be created, the suffixed form:
 *
 *    [cambium] run <id> dir=<runDir> (not yet created) trace=<tracePath> (not yet created)
 *
 *  The previous `dir=(\S+)` stopped at the first space, so a checkout under
 *  a path containing whitespace ("/Users/x/My Projects/cambium", any macOS
 *  synced folder) yielded a truncated directory and an ENOENT that pointed
 *  at a path which never existed — a harness bug wearing the costume of a
 *  product bug.
 *
 *  Anchoring on the following ` trace=` token is what makes the whitespace
 *  case unambiguous. The optional `(not yet created)` group has to be
 *  consumed explicitly: a lazy `(.+?) trace=` alone would swallow it into
 *  the captured path, since the first ` trace=` occurs after the suffix.
 */
const RUN_DIR_RE = /\bdir=(.+?)(?: \(not yet created\))? trace=/;

/** Parse the run directory, or `undefined` when stderr carries no emit.
 *  Never throws and never asserts — that is the whole point. Resolve the
 *  directory with this BEFORE any assertion, so the `finally` that cleans
 *  it up is reachable even when the assertion fails. */
export function tryReadRunDir(stderr: string): string | undefined {
  return stderr.match(RUN_DIR_RE)?.[1];
}

/** Parse the run directory, asserting the emit was present. Use at sites
 *  that have already established the run succeeded; prefer
 *  `tryReadRunDir` + `finally` anywhere a leak would otherwise be
 *  possible. */
export function readRunDir(stderr: string): string {
  const dir = tryReadRunDir(stderr);
  expect(dir, `no "dir=… trace=" emit found in stderr:\n${stderr}`).toBeTruthy();
  return dir!;
}

/** Best-effort removal of a run directory. Tolerates `undefined` so it can
 *  sit in a `finally` next to `tryReadRunDir` without a guard.
 *
 *  Policy (the open question #224 raised): a run directory is ALWAYS
 *  removed, including on failure. Leaking one accidentally and preserving
 *  one deliberately look identical on disk, and "preserve on failure" in
 *  practice means "accumulate forever" — the shared runs/ tree had
 *  accreted ~900 stale directories under the old behavior. The diagnostic
 *  value lives in stderr/stdout, which the assertions already surface.
 *
 *  Escape hatch for the case where the on-disk artifacts are genuinely
 *  what you need: `CAMBIUM_KEEP_TEST_RUNS=1 npx vitest run …` keeps them.
 */
export function cleanupRunDir(dir: string | undefined | null): void {
  if (!dir) return;
  if (process.env.CAMBIUM_KEEP_TEST_RUNS === '1') return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a cleanup failure must never fail the test.
  }
}
