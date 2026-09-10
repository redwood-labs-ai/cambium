/**
 * #233: `classifyTouchedSurfaces` — the deterministic `touched_surfaces`
 * floor for the Cambium CI Review pipeline. See DEC-004/005/006 in
 * `records/PLAN-235-233-ci-review-input-2026-09-07.md`: the workflow
 * computes this from the PR's changed-file list and the review consumes
 * the union with the LLM analyzer's own classification — deterministic
 * labels can never be dropped.
 *
 * The known-surfaces list mirrors `CAMBIUM_SURFACE`'s literal set
 * one-for-one so a typo in the rule table (e.g. `rubydsl` for `ruby_dsl`)
 * fails a test instead of silently producing a surface label the schema
 * would then reject at validation time.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyTouchedSurfaces, isCambiumTestPath } from '../src/contracts.js';

// AUD-F4: resolved from this file's own location, not `process.cwd()` —
// correct regardless of which directory `vitest` is invoked from.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');

const KNOWN_SURFACES = new Set([
  'ruby_dsl', 'compile_rb', 'ts_runner', 'step_handlers', 'trace',
  'tool_dispatch', 'exec_substrate', 'memory', 'cron', 'log', 'serve',
  'cli', 'scaffolder', 'lint', 'vscode_extension', 'docs', 'tests_only',
  'build_or_ci', 'other',
]);

describe('#233: classifyTouchedSurfaces', () => {
  it('every label it can produce is a real CAMBIUM_SURFACE literal', () => {
    // Drive every rule-bearing path plus a couple of misses, and check
    // the union of everything returned is a subset of the known enum —
    // catches a typo'd surface name in the rule table.
    const probe = [
      'ruby/cambium/runtime.rb', 'ruby/cambium/pipeline.rb', 'ruby/cambium/compile.rb',
      'ruby/cambium/cron.rb',
      'packages/cambium-runner/src/runner.ts', 'packages/cambium-runner/src/pipeline.ts',
      'packages/cambium-runner/src/step-handlers.ts',
      'packages/cambium-runner/src/tools/http.ts',
      'packages/cambium-runner/src/exec-substrate/wasm.ts',
      'packages/cambium-runner/src/memory/path.ts',
      'packages/cambium-runner/src/log/stdout.ts',
      'packages/cambium-runner/src/serve/http.ts',
      'cli/generate.mjs', 'cli/lint.mjs', 'cli/cambium.mjs',
      'vscode/cambium-syntax/package.json',
      'docs/GenDSL Docs/P - returns.md', 'README.md', 'CLAUDE.md',
      'package.json', '.forgejo/workflows/ci-review.yml', 'scripts/audit.mjs',
      'some/unmapped/path.txt',
    ];
    const got = classifyTouchedSurfaces(probe);
    for (const s of got) expect(KNOWN_SURFACES.has(s)).toBe(true);
  });

  it('maps each surface-bearing path to its documented label', () => {
    expect(classifyTouchedSurfaces(['ruby/cambium/pipeline.rb'])).toEqual(['ruby_dsl']);
    expect(classifyTouchedSurfaces(['ruby/cambium/compile.rb'])).toEqual(['compile_rb']);
    expect(classifyTouchedSurfaces(['ruby/cambium/cron.rb'])).toEqual(['cron']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/runner.ts'])).toEqual(['ts_runner']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/step-handlers.ts'])).toEqual(['step_handlers']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/tools/fetch.ts'])).toEqual(['tool_dispatch']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/exec-substrate/firecracker.ts'])).toEqual(['exec_substrate']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/memory/path.ts'])).toEqual(['memory']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/log/datadog.ts'])).toEqual(['log']);
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/serve/http.ts'])).toEqual(['serve']);
    expect(classifyTouchedSurfaces(['vscode/cambium-syntax/syntaxes/cmb.json'])).toEqual(['vscode_extension']);
    expect(classifyTouchedSurfaces(['docs/GenDSL Docs/P - returns.md'])).toEqual(['docs']);
    expect(classifyTouchedSurfaces(['README.md'])).toEqual(['docs']);
    expect(classifyTouchedSurfaces(['CLAUDE.md'])).toEqual(['docs']);
    expect(classifyTouchedSurfaces(['package.json'])).toEqual(['build_or_ci']);
    expect(classifyTouchedSurfaces(['.forgejo/workflows/ci-review.yml'])).toEqual(['build_or_ci']);
    expect(classifyTouchedSurfaces(['scripts/check-dep-ages.mjs'])).toEqual(['build_or_ci']);
  });

  it('the docs surface is the false-negative class #231/#233 exists for', () => {
    // A PR touching CLAUDE.md alongside code must never omit `docs` —
    // that is the whole point of the floor.
    const got = classifyTouchedSurfaces(['CLAUDE.md', 'ruby/cambium/runtime.rb']);
    expect(got).toContain('docs');
    expect(got).toContain('ruby_dsl');
  });

  it('cli/generate.mjs and cli/lint.mjs classify as their specific surfaces, not the broader cli catch-all', () => {
    // Order-dependence check: the specific rules must be consulted before
    // the `cli/` prefix rule that would also match both paths.
    expect(classifyTouchedSurfaces(['cli/generate.mjs'])).toEqual(['scaffolder']);
    expect(classifyTouchedSurfaces(['cli/lint.mjs'])).toEqual(['lint']);
    expect(classifyTouchedSurfaces(['cli/cambium.mjs'])).toEqual(['cli']);
  });

  it('an unmapped path falls back to `other` rather than being dropped', () => {
    expect(classifyTouchedSurfaces(['some/unmapped/path.txt'])).toEqual(['other']);
  });

  it('multiple changed files union their surfaces, deduplicated and sorted', () => {
    const got = classifyTouchedSurfaces([
      'ruby/cambium/pipeline.rb',
      'ruby/cambium/runtime.rb', // same surface as above — no duplicate entry
      'packages/cambium-runner/src/runner.ts',
    ]);
    expect(got).toEqual(['ruby_dsl', 'ts_runner']);
  });

  it('OQ-001: tests_only is a whole-set predicate, not a per-file label', () => {
    // Neither test path matches a specific surface rule (they fall to the
    // `other` catch-all on a per-path basis) — `tests_only` is added on
    // top by the separate whole-set pass, not instead of it.
    expect(classifyTouchedSurfaces(['packages/cambium-runner/src/runner.test.ts'])).toEqual(['other', 'tests_only']);
    expect(classifyTouchedSurfaces(['ruby/cambium/pipeline_test.test.rb'])).toEqual(['other', 'tests_only']);
    // Mixed: one test file + one non-test file — the diff is NOT tests-only,
    // and the non-test file's own surface still applies.
    const mixed = classifyTouchedSurfaces([
      'packages/cambium-runner/src/runner.test.ts',
      'ruby/cambium/pipeline.rb',
    ]);
    expect(mixed).not.toContain('tests_only');
    expect(mixed).toContain('ruby_dsl');
  });

  it('empty input maps to no surfaces at all, not a vacuous tests_only', () => {
    expect(classifyTouchedSurfaces([])).toEqual([]);
  });

  it('isCambiumTestPath matches the *.test.ts / *.test.rb convention only', () => {
    expect(isCambiumTestPath('packages/cambium-runner/src/runner.test.ts')).toBe(true);
    expect(isCambiumTestPath('ruby/cambium/foo.test.rb')).toBe(true);
    expect(isCambiumTestPath('ruby/cambium/foo.rb')).toBe(false);
    expect(isCambiumTestPath('packages/cambium-runner/src/runner.ts')).toBe(false);
  });
});

/**
 * AUD-001/AUD-F2/AUD-F3 (round 1 + round 2 audit): `git diff --name-only`
 * (no `-z`) C-quotes any path containing a byte outside 0x20-0x7e (plus
 * `"` / `\`) — e.g. the repo's own em-dash-named docs files. Round 1's
 * regression tests exercised `classifyTouchedSurfaces` directly, which was
 * never the buggy component; the auditor reverted `ci-review.yml` and
 * `ci-review-input.mjs` to pre-fix and got 13/13 green while the real bug
 * reproduced end to end (AUD-F3) — a test that cannot fail is worse than no
 * test.
 *
 * These tests instead exercise the WORKFLOW <-> SCRIPT CONTRACT itself:
 * `extractWorkflowNameOnlyFlags` reads `.forgejo/workflows/ci-review.yml`'s
 * actual current bytes at run time (not a copy of them), and
 * `runRealWorkflowContract` runs the real `git` invocation those flags
 * produce, on a real historical commit range, piped into the real
 * `scripts/ci-review-input.mjs` on disk. Two properties fall out of that
 * shape without asserting on either file's text directly:
 *
 *   - Reverting `-z` in ci-review.yml -> `extractWorkflowNameOnlyFlags`
 *     returns flags without `-z` -> git C-quotes the em-dash paths, no NUL
 *     byte anywhere in its output -> the script's AUD-F2 guard (below)
 *     rejects it and exits non-zero -> the "AS AUTHORED" test's
 *     `expect(status).toBe(0)` fails. RED.
 *   - Reverting the script's NUL split back to a newline split -> the
 *     guard's `.includes('\0')` check still passes (real `-z` output has
 *     NULs), but `.split('\n')` finds no `\n` in a `-z` stream, so the
 *     whole multi-file list collapses into one pseudo-path. The historical
 *     range's first path (`.gitignore`, alphabetically first, not under
 *     `docs/`) means the collapsed blob classifies as `other` only,
 *     losing `docs` entirely -> the same test's `not.toEqual(['other'])`
 *     fails. RED.
 *
 * AUD-F4 hardening applied throughout: paths resolve from this file's own
 * location (`import.meta.url`), not `process.cwd()`; the historical-range
 * tests skip (not fail) when the commit is unreachable (shallow clone);
 * every `spawnSync` carries an explicit timeout; and — since every git
 * invocation here already passes `-z` — none of them depend on the
 * ambient `core.quotePath` setting (a plain, non-`-z` `--name-only` call
 * never appears in this file, which is also *why* AUD-F4's sub-issue 1
 * cannot recur here).
 */
describe('AUD-001/AUD-F2/AUD-F3: workflow <-> script contract for non-ASCII paths', () => {
  const WORKFLOW_PATH = join(REPO_ROOT, '.forgejo', 'workflows', 'ci-review.yml');
  const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'ci-review-input.mjs');
  const SPAWN_TIMEOUT_MS = 15_000;

  // A real, immutable commit range in this repo's own history that touched
  // 43 files, including the repo's em-dash-named docs files, with a
  // non-docs file (`.gitignore`) sorting first. That ordering is load-
  // bearing for the AUD-F2 property above: a newline-split collapse of
  // this exact range's NUL-separated output does NOT accidentally still
  // start with `docs/`.
  const RANGE = '0aa520c^..0aa520c';

  function rangeReachable(): boolean {
    const check = spawnSync('git', ['diff', '--name-only', RANGE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    return check.status === 0 && check.stdout.trim().length > 0;
  }
  const HAVE_FIXTURE = rangeReachable();

  /** Weaker than `rangeReachable()`: the pin below needs only a git repo with
   *  the file tracked, not the full history `0aa520c` lives in. The Ruby 3.x
   *  container gate (`scripts/test-on-ruby.mjs`) runs the suite against a
   *  `git archive HEAD` export — tracked files, no `.git` — so `git` exits 128
   *  there and the very thing this pins (git's own quoting of the em-dash
   *  paths) cannot be observed at all. Skip rather than fail: where there is
   *  no git, there is no git behavior to assert. */
  function haveGitRepo(): boolean {
    const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    return check.status === 0;
  }
  const HAVE_GIT_REPO = haveGitRepo();

  describe.skipIf(!HAVE_FIXTURE)('fixture-dependent (needs full history for 0aa520c; skips under a shallow clone)', () => {
    /** The exact flags `.forgejo/workflows/ci-review.yml` passes to
     *  `git diff --name-only` between the subcommand and `"$BASE_SHA"...HEAD`
     *  — e.g. `['-z']` today. Reads the workflow file itself, live, every
     *  call: this is what ties the test to the file's actual current
     *  content instead of a snapshot of it. */
    function extractWorkflowNameOnlyFlags(): string[] {
      const wf = readFileSync(WORKFLOW_PATH, 'utf8');
      const m = wf.match(/git diff --name-only((?:\s+\S+)*?)\s+"\$BASE_SHA"\.\.\.HEAD/);
      expect(
        m,
        'could not find the `git diff --name-only ... "$BASE_SHA"...HEAD` line in ci-review.yml — did the step get renamed or reshaped?',
      ).toBeTruthy();
      const flagsStr = m![1].trim();
      return flagsStr.length > 0 ? flagsStr.split(/\s+/) : [];
    }

    /** Run the workflow's ACTUAL invocation shape (its real current flags,
     *  our own real commit range standing in for `"$BASE_SHA"...HEAD`) and
     *  pipe the raw output into the ACTUAL `scripts/ci-review-input.mjs` on
     *  disk — the same two artifacts the real workflow wires together,
     *  exercised the same way, with nothing hand-approximated in between. */
    function runRealWorkflowContract() {
      const flags = extractWorkflowNameOnlyFlags();
      const diffNames = spawnSync('git', ['diff', '--name-only', ...flags, RANGE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(diffNames.status, diffNames.stderr).toBe(0);

      const scratch = mkdtempSync(join(tmpdir(), 'aud-f3-'));
      const diffFile = join(scratch, 'pr.diff');
      writeFileSync(diffFile, 'placeholder diff text — not under test here');
      try {
        return spawnSync('node', [SCRIPT_PATH, diffFile], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          input: diffNames.stdout,
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }

    it('AS AUTHORED: the real workflow invocation, piped into the real script, classifies the em-dash-docs commit correctly — and is exactly the assertion that reverting either fix turns red (see block comment above)', () => {
      const result = runRealWorkflowContract();
      expect(result.status, result.stderr).toBe(0);
      const surfaces = JSON.parse(result.stdout).surfaces;
      // The real 43-file range spans five known surfaces, including `docs`
      // via the em-dash-named files. Asserting the full set (not just
      // `.toContain('docs')`) means a *partial* collapse — e.g. one docs
      // file surviving by accident — still fails loudly.
      expect(surfaces.sort()).toEqual(
        ['compile_rb', 'docs', 'other', 'ruby_dsl', 'vscode_extension'].sort(),
      );
      // Named explicitly: this is the exact wrong answer both reverts
      // produce (AUD-F2's repro and the original AUD-001 bug alike).
      expect(surfaces).not.toEqual(['other']);
    });
  });

  // Script-level pins of the AUD-F2 guard itself. No git history needed —
  // these hand-build the two byte shapes the guard has to tell apart —
  // so they are NOT gated behind `HAVE_FIXTURE` and always run.
  describe('AUD-F2: the script rejects non-NUL-separated stdin instead of mis-parsing it', () => {
    function runScript(stdin: string) {
      const scratch = mkdtempSync(join(tmpdir(), 'aud-f2-'));
      const diffFile = join(scratch, 'pr.diff');
      writeFileSync(diffFile, 'placeholder');
      try {
        return spawnSync('node', [SCRIPT_PATH, diffFile], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          input: stdin,
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }

    it('newline-separated (no NUL) input — the shape plain `--name-only` produces — exits non-zero naming the expected format', () => {
      const result = runScript('packages/cambium-runner/src/runner.ts\ndocs/a.md\n');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/NUL-separated/);
      expect(result.stderr).toMatch(/-z/);
    });

    it('zero-byte stdin (a genuinely empty diff) still succeeds with surfaces: []', () => {
      const result = runScript('');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).surfaces).toEqual([]);
    });

    it('correct NUL-terminated input — including the single-file case, which still contains one NUL — classifies correctly', () => {
      const singleFile = runScript('docs/a.md\0');
      expect(singleFile.status, singleFile.stderr).toBe(0);
      expect(JSON.parse(singleFile.stdout).surfaces).toEqual(['docs']);

      const multiFile = runScript('packages/cambium-runner/src/runner.ts\0docs/a.md\0');
      expect(multiFile.status, multiFile.stderr).toBe(0);
      expect(JSON.parse(multiFile.stdout).surfaces.sort()).toEqual(['docs', 'ts_runner'].sort());
    });
  });

  it.skipIf(!HAVE_GIT_REPO)('direct unit-pin (round 1 style): the real tracked em-dash docs filename classifies as docs, with no git-quoting in the way (`ls-files -z`)', () => {
    const lsFiles = spawnSync('git', ['ls-files', '-z', '--', 'docs/Generation Engineering DSL*.md'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(lsFiles.status, lsFiles.stderr).toBe(0);
    const realPaths = lsFiles.stdout.split('\0').map((s) => s.trim()).filter(Boolean);
    const referenceImpl = realPaths.find((p) => p.includes('Reference Implementation'));
    expect(referenceImpl).toBeTruthy();
    expect(classifyTouchedSurfaces([referenceImpl!])).toEqual(['docs']);
  });
});
