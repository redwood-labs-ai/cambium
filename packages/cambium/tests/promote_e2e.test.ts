/**
 * #199: `cambium promote <run-id|path>` end-to-end, driven through the real
 * CLI (spawn), against a throwaway in-tree gen — mirroring
 * replay_repair_e2e.test.ts's convention (no isolated scratch workspace;
 * the CLI's own scaffolder + fixtures/tests conventions only make sense
 * inside a real app-mode workspace, and this repo's packages/cambium/ is
 * one). Every artifact this file creates is prefixed with the throwaway
 * gen's snake name and removed in beforeAll/afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const PKG = 'packages/cambium';
const NAME = 'PromoteE2eProbe';
const SNAKE = 'promote_e2e_probe';

const GEN_REL = `${PKG}/app/gens/${SNAKE}.cmb.rb`;
const SYSTEM_REL = `${PKG}/app/systems/${SNAKE}.system.md`;
const TEST_REL = `${PKG}/tests/${SNAKE}.test.ts`;
const FIXTURES_DIR = join(REPO_ROOT, PKG, 'examples/fixtures');
// #263: `golden/acceptance.test.ts`'s collection-time scan now excludes
// any `.cmb.rb`/`.pipeline.rb` basename containing `_e2e_probe` (every
// filename this suite scaffolds into the real app/gens/ carries that
// marker) — that exclusion filter is the actual fix for the race this
// comment used to describe. This sweep is retained as belt-and-braces
// (DEC-004): it should never have anything to remove once the filter is
// in place, but it guards against a future regression (a typo'd marker,
// a future scaffold-into-real-directory test that forgets the
// convention) leaving a stray committed-looking snapshot behind. See
// records/PLAN-263-golden-ir-race-2026-09-11.md.
const GOLDEN_IR_SNAPSHOT = join(REPO_ROOT, `${PKG}/tests/golden/ir/gens/${SNAKE}.json`);

function cambium(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

/** Extract the run id from `cambium run`'s "[cambium] run <id> ..." stderr line
 *  (same convention replay_repair_e2e.test.ts uses). */
function runIdFromStderr(stderr: string): string {
  const m = stderr.match(/\[cambium\] run (run_\S+?) /);
  if (!m) throw new Error(`no run id in stderr:\n${stderr}`);
  return m[1];
}

const cleanupRunDirs = new Set<string>();

function removeScaffoldArtifacts() {
  for (const rel of [GEN_REL, SYSTEM_REL, TEST_REL]) {
    const p = join(REPO_ROOT, rel);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(FIXTURES_DIR)) {
    for (const f of readdirSync(FIXTURES_DIR)) {
      if (f.startsWith(`${SNAKE}-`)) rmSync(join(FIXTURES_DIR, f), { force: true });
    }
  }
  if (existsSync(GOLDEN_IR_SNAPSHOT)) rmSync(GOLDEN_IR_SNAPSHOT, { force: true });
}

describe('#199: cambium promote end-to-end (mock, real CLI)', () => {
  beforeAll(() => {
    removeScaffoldArtifacts(); // clean slate if a prior crashed run left artifacts
    const scaffold = cambium(['new', 'agent', NAME]);
    expect(scaffold.status, `scaffold failed:\n${scaffold.stderr}`).toBe(0);
    // The scaffold's own test carries the TODO placeholder — remove it so
    // this suite's first promote exercises DEC-004 case 1 (absent), not
    // case 2 (placeholder present). `cambium new agent` always writes one;
    // promote's own case-2/case-3 matrix is unit-tested (STEP-005) against
    // fabricated file content, not re-derived here.
    const testPath = join(REPO_ROOT, TEST_REL);
    if (existsSync(testPath)) rmSync(testPath, { force: true });
  });

  afterAll(() => {
    removeScaffoldArtifacts();
    for (const id of cleanupRunDirs) {
      const dir = join(REPO_ROOT, 'runs', id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mock-run promote (case 1: absent test) writes fixture + snapshot + test, and vitest reports the golden green', () => {
    const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
    const run = cambium(['run', GEN_REL, '--method', 'analyze', '--arg', fixture, '--mock']);
    expect(run.status, `run failed:\n${run.stderr}`).toBe(0);
    const runId = runIdFromStderr(run.stderr);
    cleanupRunDirs.add(runId);

    const promote = cambium(['promote', runId]);
    expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);
    expect(promote.stdout).toContain('created test:');

    const fixturePath = join(FIXTURES_DIR, `${SNAKE}-promoted-document.txt`);
    const snapshotPath = join(FIXTURES_DIR, `${SNAKE}-snapshot.json`);
    const testPath = join(REPO_ROOT, TEST_REL);
    expect(existsSync(fixturePath)).toBe(true);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(existsSync(testPath)).toBe(true);

    const vitestRun = spawnSync('npx', ['vitest', 'run', TEST_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(vitestRun.status, `vitest failed:\n${vitestRun.stdout}\n${vitestRun.stderr}`).toBe(0);

    // FIX-PINNING (#199 DEC-009, was bug-pinning — see CHANGE-199 DEV-003):
    // `goldenTestSource`'s SNAPSHOT line used to be
    // `join(REPO_ROOT, '<PKG-absolute-path>/…')`; since `PKG` (ctx.appPkgRoot)
    // is always absolute, that doubled into a path that never exists, so the
    // golden's second `it` block always saw `!existsSync(SNAPSHOT)` and
    // warn-skipped — green, but no comparison against the promoted snapshot
    // ever ran. The line is now a plain literal (like GEN/FIXTURE), so the
    // warn-skip must not fire...
    expect(vitestRun.stderr).not.toContain('snapshot not found');
    // ...and the comparison must actually execute: corrupt the promoted
    // snapshot and prove vitest goes red against it, then restore and prove
    // it goes green again. A warn-skip would stay green through the
    // corruption too, so this is the demonstration that the assertion above
    // isn't itself just a weaker way to pin the same bug.
    const snapshotBefore = readFileSync(snapshotPath, 'utf8');
    const corrupted = JSON.parse(snapshotBefore);
    corrupted.__promote_e2e_corruption_probe = 'this value can never match the mock output';
    writeFileSync(snapshotPath, JSON.stringify(corrupted, null, 2));

    const vitestRed = spawnSync('npx', ['vitest', 'run', TEST_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(vitestRed.status, `expected vitest to fail against a corrupted snapshot:\n${vitestRed.stdout}`).not.toBe(0);
    expect(vitestRed.stdout).toContain('difference(s)');

    writeFileSync(snapshotPath, snapshotBefore);
    const vitestGreenAgain = spawnSync('npx', ['vitest', 'run', TEST_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(
      vitestGreenAgain.status,
      `vitest failed after restoring the snapshot:\n${vitestGreenAgain.stdout}\n${vitestGreenAgain.stderr}`,
    ).toBe(0);
  });

  it('re-promoting without --force refuses (exit 2) and writes nothing; --force then succeeds', () => {
    const fixturePath = join(FIXTURES_DIR, `${SNAKE}-promoted-document.txt`);
    const snapshotPath = join(FIXTURES_DIR, `${SNAKE}-snapshot.json`);
    const testPath = join(REPO_ROOT, TEST_REL);
    const before = {
      fixture: readFileSync(fixturePath, 'utf8'),
      snapshot: readFileSync(snapshotPath, 'utf8'),
      test: readFileSync(testPath, 'utf8'),
    };

    const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
    const run = cambium(['run', GEN_REL, '--method', 'analyze', '--arg', fixture, '--mock']);
    expect(run.status, `run failed:\n${run.stderr}`).toBe(0);
    const runId = runIdFromStderr(run.stderr);
    cleanupRunDirs.add(runId);

    const noForce = cambium(['promote', runId]);
    expect(noForce.status).toBe(2);
    expect(noForce.stderr).toContain('Nothing written');
    expect(readFileSync(fixturePath, 'utf8')).toBe(before.fixture);
    expect(readFileSync(snapshotPath, 'utf8')).toBe(before.snapshot);
    expect(readFileSync(testPath, 'utf8')).toBe(before.test); // untouched: case 3, no-touch

    const forced = cambium(['promote', runId, '--force']);
    expect(forced.status, `--force promote failed:\n${forced.stdout}\n${forced.stderr}`).toBe(0);
    expect(forced.stdout).toContain('left test untouched (already wired):'); // DEC-004 case 3
    // Fixture/snapshot ARE rewritten under --force (both runs are --mock
    // against the same fixture, so content happens to be identical here —
    // the meaningful proof is that promote didn't refuse).
    expect(existsSync(fixturePath)).toBe(true);
    expect(existsSync(snapshotPath)).toBe(true);
  });

  it('DEC-001: a promoted non-mock-shaped run mints a fresh --mock snapshot, never copies output.json', () => {
    // No live model provider is available in this environment, so this
    // simulates "a real (non-mock) run" the way the manual verification
    // in CHANGE-199 did: take a real ir.json and pair it with a
    // fabricated output.json a --mock run could never produce. If
    // promote ever regressed to copying output.json instead of minting,
    // this test goes red — the exact revert-proof the plan calls for.
    const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
    const realRun = cambium(['run', GEN_REL, '--method', 'analyze', '--arg', fixture, '--mock']);
    expect(realRun.status, `run failed:\n${realRun.stderr}`).toBe(0);
    const realRunId = runIdFromStderr(realRun.stderr);
    cleanupRunDirs.add(realRunId);

    const fakeRunId = 'run_20260101_010101_fabbed';
    cleanupRunDirs.add(fakeRunId);
    const fakeDir = join(REPO_ROOT, 'runs', fakeRunId);
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(
      join(fakeDir, 'ir.json'),
      readFileSync(join(REPO_ROOT, 'runs', realRunId, 'ir.json'), 'utf8'),
    );
    const sentinel = { summary: 'REAL-NOT-MOCK sentinel output that --mock would never produce' };
    writeFileSync(join(fakeDir, 'output.json'), JSON.stringify(sentinel));

    const promote = cambium(['promote', fakeRunId, '--force']);
    expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);

    const snapshotPath = join(FIXTURES_DIR, `${SNAKE}-snapshot.json`);
    const written = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(written).not.toEqual(sentinel);
    expect(written.summary).not.toContain('REAL-NOT-MOCK');
  });

  it('DEC-006: promoting a run with no output.json (a failed run) still works — only ir.json is required', () => {
    const compiled = join(REPO_ROOT, `${SNAKE}-failed-run.ir.json`);
    const compile = cambium(['compile', GEN_REL, '--method', 'analyze', '-o', compiled]);
    expect(compile.status, `compile failed:\n${compile.stderr}`).toBe(0);

    const failedRunId = 'run_20260101_020202_fa17ed';
    cleanupRunDirs.add(failedRunId);
    const failedDir = join(REPO_ROOT, 'runs', failedRunId);
    mkdirSync(failedDir, { recursive: true });
    writeFileSync(join(failedDir, 'ir.json'), readFileSync(compiled, 'utf8'));
    rmSync(compiled, { force: true });

    const promote = cambium(['promote', failedRunId, '--force']);
    expect(promote.stderr).toContain('has no output.json (a failed run)');
    expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);
  });

  it('refuses a Pipeline artifact citing the gens-first non-goal', () => {
    const pipeline = 'packages/cambium/app/pipelines/sample_pipeline.pipeline.rb';
    const arg = join(REPO_ROOT, `${SNAKE}-pipeline-arg.json`);
    writeFileSync(arg, JSON.stringify({ document: 'hello world' }));
    try {
      const run = cambium(['run', pipeline, '--method', 'review', '--arg', arg, '--mock']);
      expect(run.status, `pipeline run failed:\n${run.stderr}`).toBe(0);
      const runId = runIdFromStderr(run.stderr);

      // Pipeline run ids use a different shape (run_<date>T<time>Z_<hex>)
      // than gen run ids — RUN_ID_REGEX (gen-id-shaped) legitimately
      // refuses the bare form as "Invalid run id" before ever reading
      // ir.json. The path form reaches the ir.json read and hits the
      // DEC-006-specified message; assert against that form (see
      // CHANGE-199 DEV-002 for the bare-id-form caveat).
      const promote = cambium(['promote', join('packages/cambium/runs', runId)]);
      expect(promote.status).toBe(2);
      expect(promote.stderr).toContain('is a Pipeline run');
      expect(promote.stderr).toContain('non-goal');

      const runDir = join(REPO_ROOT, 'packages/cambium/runs', runId);
      if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
    } finally {
      rmSync(arg, { force: true });
    }
  });

  it('refuses a malformed run id (exit 2)', () => {
    const promote = cambium(['promote', 'not-a-real-run-id']);
    expect(promote.status).toBe(2);
    expect(promote.stderr).toContain('Invalid run id');
  });

  it('DEC-011: warns (without editing) when a wired test\'s GEN line no longer matches the run\'s entry.source', () => {
    // AUD-002's relocated-gen scenario: a second file with the SAME class
    // content but a DIFFERENT filename — Ruby cares about the class name
    // inside, not the file's location. The test wired by the very first
    // test in this file (case 1, above) points GEN at GEN_REL; promoting a
    // run whose entry.source is this moved file must warn, not silently
    // wire the wrong GEN (or edit it).
    const movedRel = `${PKG}/app/gens/${SNAKE}_moved.cmb.rb`;
    const movedPath = join(REPO_ROOT, movedRel);
    writeFileSync(movedPath, readFileSync(join(REPO_ROOT, GEN_REL), 'utf8'));
    try {
      const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
      const run = cambium(['run', movedRel, '--method', 'analyze', '--arg', fixture, '--mock']);
      expect(run.status, `run failed:\n${run.stderr}`).toBe(0);
      const runId = runIdFromStderr(run.stderr);
      cleanupRunDirs.add(runId);

      const testPath = join(REPO_ROOT, TEST_REL);
      const before = readFileSync(testPath, 'utf8');

      const promote = cambium(['promote', runId, '--force']);
      expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);
      expect(promote.stdout).toContain("WARNING: this test's GEN line does not match this run's gen source.");
      expect(promote.stdout).toContain(`run:  const GEN = '${movedRel}'`);

      // The GEN line itself — and the rest of the wired test — is untouched.
      expect(readFileSync(testPath, 'utf8')).toBe(before);
    } finally {
      rmSync(movedPath, { force: true });
    }
  });

  it('AUD-002 (fixed): a FRESH test for a relocated gen derives GEN from entry.source, and the golden passes', () => {
    // Same relocation shape as the DEC-011 test above, but against a
    // never-before-promoted test (case 1 — DEC-004 "absent") so the fix
    // is exercised end to end: GEN must be the moved file, not the
    // filename convention, and `npx vitest run` on the result must
    // actually pass (before AUD-002's fix, this went red — see
    // SECURITY-AUDIT-199-2026-09-10.md).
    const AUD2_SNAKE = `${SNAKE}_aud2`;
    const conventionalRel = `${PKG}/app/gens/${AUD2_SNAKE}.cmb.rb`;
    const movedRel = `${PKG}/app/gens/${AUD2_SNAKE}_moved.cmb.rb`;
    const testRel = `${PKG}/tests/${AUD2_SNAKE}.test.ts`;
    const conventionalPath = join(REPO_ROOT, conventionalRel);
    const movedPath = join(REPO_ROOT, movedRel);
    const testPath = join(REPO_ROOT, testRel);

    // Reuse the probe gen's own source, renamed to a class that doesn't
    // collide with SNAKE's, at a location that does NOT match the
    // <pkg>/app/gens/<snake(class)>.cmb.rb convention for its own class.
    const genClass = 'PromoteE2eProbeAud2';
    const body = readFileSync(join(REPO_ROOT, GEN_REL), 'utf8').replace(
      /class PromoteE2eProbe\b/,
      `class ${genClass}`,
    );
    writeFileSync(movedPath, body);

    try {
      const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
      const run = cambium(['run', movedRel, '--method', 'analyze', '--arg', fixture, '--mock']);
      expect(run.status, `run failed:\n${run.stderr}`).toBe(0);
      const runId = runIdFromStderr(run.stderr);
      cleanupRunDirs.add(runId);

      expect(existsSync(conventionalPath)).toBe(false); // sanity: genuinely non-conventional

      const promote = cambium(['promote', runId]);
      expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);
      expect(promote.stdout).toContain('created test:');
      expect(promote.stdout).not.toContain('WARNING'); // fresh test — nothing to mismatch against yet

      // #199 DEC-012: GEN is emitted via JSON.stringify, not a raw
      // single-quoted splice — movedRel has no characters that need
      // escaping, so this is just double-quoted, same value.
      expect(readFileSync(testPath, 'utf8')).toContain(`const GEN = ${JSON.stringify(movedRel)}`);

      const vitestRun = spawnSync('npx', ['vitest', 'run', testRel], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      expect(vitestRun.status, `vitest failed:\n${vitestRun.stdout}\n${vitestRun.stderr}`).toBe(0);
    } finally {
      rmSync(movedPath, { force: true });
      rmSync(testPath, { force: true });
      const fixturesDir = FIXTURES_DIR;
      if (existsSync(fixturesDir)) {
        for (const f of readdirSync(fixturesDir)) {
          if (f.startsWith(`${AUD2_SNAKE}-`)) rmSync(join(fixturesDir, f), { force: true });
        }
      }
      const goldenIrSnapshot = join(REPO_ROOT, `${PKG}/tests/golden/ir/gens/${AUD2_SNAKE}.json`);
      if (existsSync(goldenIrSnapshot)) rmSync(goldenIrSnapshot, { force: true });
    }
  });

  it("#199 DEC-012: a quote/backtick/\${-bearing entry.source cannot break out of the generated GEN literal (fresh test, case 1)", () => {
    // PIPELINE-199 § "Round-2 cambium-security delta": `goldenTestSource`
    // used to splice `genRel` raw into `const GEN = '${genRel}'`. A
    // workspace-contained gen FILENAME (Ruby cares about the class
    // inside, not the file's name — same fact AUD-002's relocated-gen
    // scenario above relies on) carrying a single quote closes that
    // literal early; this specific shape ("x'; <statement>; const
    // _z='.cmb.rb") re-opens a second string that the template's own
    // trailing quote then closes, so the whole thing still parses and
    // the injected statement runs as live top-level code on the next
    // `vitest run`. Extended with a backtick and a literal "${" (both
    // otherwise-inert here, but exactly what DEC-012 requires
    // JSON.stringify to also handle safely).
    const INJECT_SNAKE = `${SNAKE}_inject`;
    const injectClass = 'PromoteE2eProbeInject';
    const payloadBasename =
      `${INJECT_SNAKE}_` + "x`${1}'; console.log('DEC012_INJECTED_' + 'MARKER'); const _z='.cmb.rb";
    const injectRel = `${PKG}/app/gens/${payloadBasename}`;
    const injectPath = join(REPO_ROOT, injectRel);
    const testRel = `${PKG}/tests/${INJECT_SNAKE}.test.ts`;
    const testPath = join(REPO_ROOT, testRel);

    const body = readFileSync(join(REPO_ROOT, GEN_REL), 'utf8').replace(
      /class PromoteE2eProbe\b/,
      `class ${injectClass}`,
    );
    writeFileSync(injectPath, body);

    try {
      const fixture = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');
      const run = cambium(['run', injectRel, '--method', 'analyze', '--arg', fixture, '--mock']);
      expect(run.status, `run failed:\n${run.stderr}`).toBe(0);
      const runId = runIdFromStderr(run.stderr);
      cleanupRunDirs.add(runId);

      expect(existsSync(testPath)).toBe(false); // sanity: case 1, fresh

      const promote = cambium(['promote', runId]);
      expect(promote.status, `promote failed:\n${promote.stdout}\n${promote.stderr}`).toBe(0);
      expect(promote.stdout).toContain('created test:');

      const content = readFileSync(testPath, 'utf8');

      // The payload must appear ONLY inside the quoted GEN literal, as a
      // single JSON string that round-trips to the exact injectRel value
      // — never as a second, live top-level occurrence of the injected
      // statement.
      const genLineMatch = content.match(/^const GEN = (".*")$/m);
      expect(genLineMatch, `no GEN line found in:\n${content}`).not.toBeNull();
      expect(JSON.parse(genLineMatch![1])).toBe(injectRel);

      const rawSignature = "console.log('DEC012_INJECTED_' + 'MARKER')";
      const totalOccurrences = content.split(rawSignature).length - 1;
      const occurrencesInGenLine = genLineMatch![0].split(rawSignature).length - 1;
      expect(occurrencesInGenLine).toBeGreaterThan(0);
      expect(totalOccurrences).toBe(occurrencesInGenLine);

      // The actual runtime proof: a real `vitest run` against the
      // generated golden must never print the concatenated marker. If
      // the breakout fired, `console.log('DEC012_INJECTED_' + 'MARKER')`
      // would execute at module load — before any test body runs — and
      // land in stdout regardless of the test's own pass/fail outcome.
      const vitestRun = spawnSync('npx', ['vitest', 'run', testRel], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      expect(vitestRun.stdout).not.toContain('DEC012_INJECTED_MARKER');
      expect(vitestRun.stderr).not.toContain('DEC012_INJECTED_MARKER');
      // And the golden itself must still pass — the fix must not merely
      // neutralize the payload by breaking promote's own output.
      expect(vitestRun.status, `vitest failed:\n${vitestRun.stdout}\n${vitestRun.stderr}`).toBe(0);
    } finally {
      rmSync(injectPath, { force: true });
      rmSync(testPath, { force: true });
      const fixturesDir = FIXTURES_DIR;
      if (existsSync(fixturesDir)) {
        for (const f of readdirSync(fixturesDir)) {
          if (f.startsWith(`${INJECT_SNAKE}-`)) rmSync(join(fixturesDir, f), { force: true });
        }
      }
      const goldenIrSnapshot = join(REPO_ROOT, `${PKG}/tests/golden/ir/gens/${INJECT_SNAKE}.json`);
      if (existsSync(goldenIrSnapshot)) rmSync(goldenIrSnapshot, { force: true });
    }
  });
});
