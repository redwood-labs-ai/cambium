/**
 * Golden IR corpus — acceptance tests.
 *
 * Compiles every in-tree gen and pipeline in bare mode (no --method,
 * no --arg) and pins the result as a committed JSON snapshot. A diff
 * in the compiled IR shows up as a failing snapshot in CI; updating the
 * snapshot (`vitest run -u`) is the intentional upgrade path.
 *
 * DEC-004: spawn with cwd = repo root + repo-root-relative path so the
 * IR's `source` field is a stable relative string (not an absolute path
 * with a username in it).
 *
 * DEC-004a: the compiler stdout is re-serialized through
 * JSON.stringify(JSON.parse(...), null, 2) before snapshotting. This makes
 * JS the sole formatting authority and eliminates cross-Ruby-version
 * whitespace differences in empty containers (json-gem 2.9.1 emits `[]`/`{}`
 * while older apt Ruby emits `[\n\n]`/`{\n}`).
 *
 * Run offline: `npm run test:golden` — no LLM, no secrets.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

const REPO_ROOT = process.cwd()
const COMPILE = 'ruby/cambium/compile.rb'

const GENS_DIR = join(REPO_ROOT, 'packages/cambium/app/gens')
const PIPELINES_DIR = join(REPO_ROOT, 'packages/cambium/app/pipelines')
const SNAPSHOTS_DIR = join(REPO_ROOT, 'packages/cambium/tests/golden/ir')

// #263: any CLI e2e test that scaffolds a throwaway gen/pipeline into
// this real, in-tree app/gens/ or app/pipelines/ directory (not an
// isolated tmpdir scratch workspace) for the duration of its own run,
// then deletes it, can otherwise race THIS file's collection-time scan
// — either leaking a committed-looking snapshot for a gen nobody meant
// to pin, or (worse) getting collected and then failing to compile
// because the sibling test's cleanup already deleted the file. Closed
// structurally, not by timing: any basename containing this marker is
// excluded from collection outright, regardless of when it happens to
// exist on disk. `promote_e2e.test.ts` is (as of #263) the only test
// that scaffolds into this real directory, and every filename it uses
// there carries this marker. See records/PLAN-263-golden-ir-race-2026-09-11.md.
const TEST_SCAFFOLD_MARKER = '_e2e_probe';

/** True if `basename` is a throwaway artifact a CLI e2e test scaffolds
 *  into a real app/gens/ or app/pipelines/ directory (#263) — must be
 *  excluded from the golden-IR corpus regardless of timing. */
function isScaffoldTestArtifact(basename: string): boolean {
  return basename.includes(TEST_SCAFFOLD_MARKER);
}

/** List all files in dir ending with ext, sorted, full absolute paths.
 *  Excludes scaffold-test artifacts (#263) — see isScaffoldTestArtifact. */
function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(ext) && !isScaffoldTestArtifact(f))
      .sort()
      .map(f => join(dir, f))
  } catch {
    return []
  }
}

const genFiles = listFiles(GENS_DIR, '.cmb.rb')
const pipelineFiles = listFiles(PIPELINES_DIR, '.pipeline.rb')

describe('golden IR corpus — acceptance', () => {
  describe('gens', () => {
    it.each(genFiles.map(f => [basename(f, '.cmb.rb'), f] as [string, string]))(
      '%s',
      async (stem, absPath) => {
        const relPath = relative(REPO_ROOT, absPath)
        const result = spawnSync('ruby', [COMPILE, relPath], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        })
        expect(
          result.status,
          `${relPath} failed to compile (exit ${result.status}):\n${result.stderr}`,
        ).toBe(0)
        const snapshotPath = join(SNAPSHOTS_DIR, 'gens', `${stem}.json`)
        await expect(JSON.stringify(JSON.parse(result.stdout), null, 2)).toMatchFileSnapshot(snapshotPath)
      },
    )
  })

  describe('pipelines', () => {
    it.each(pipelineFiles.map(f => [basename(f, '.pipeline.rb'), f] as [string, string]))(
      '%s',
      async (stem, absPath) => {
        const relPath = relative(REPO_ROOT, absPath)
        const result = spawnSync('ruby', [COMPILE, relPath], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        })
        expect(
          result.status,
          `${relPath} failed to compile (exit ${result.status}):\n${result.stderr}`,
        ).toBe(0)
        const snapshotPath = join(SNAPSHOTS_DIR, 'pipelines', `${stem}.json`)
        await expect(JSON.stringify(JSON.parse(result.stdout), null, 2)).toMatchFileSnapshot(snapshotPath)
      },
    )
  })
})

describe('#263: scaffold-test artifact exclusion (regression)', () => {
  it('excludes every filename shape promote_e2e.test.ts currently scaffolds into app/gens/', () => {
    expect(isScaffoldTestArtifact('promote_e2e_probe.cmb.rb')).toBe(true);
    expect(isScaffoldTestArtifact('promote_e2e_probe_moved.cmb.rb')).toBe(true);
    expect(isScaffoldTestArtifact('promote_e2e_probe_aud2_moved.cmb.rb')).toBe(true);
    expect(isScaffoldTestArtifact("promote_e2e_probe_inject_x`${1}'; const _z='.cmb.rb")).toBe(true);
  });

  it('does not exclude a real, committed gen', () => {
    expect(isScaffoldTestArtifact('analyst.cmb.rb')).toBe(false);
  });

  // AUD-263-1: pins the boundary of what collides with the substring
  // marker — a future PR renaming a real gen into a shape that merely
  // resembles it (without the exact `_e2e_probe` compound) has
  // somewhere to trip. Substring matching over a suffix anchor or a
  // hardcoded count is DEC-002/DEC-006's deliberate tradeoff, not
  // closed by this test.
  it('does not exclude names that merely resemble the marker', () => {
    expect(isScaffoldTestArtifact('e2e_smoke_test.cmb.rb')).toBe(false);
    expect(isScaffoldTestArtifact('probe_investigator.cmb.rb')).toBe(false);
  });

  it('none of the currently-collected gens or pipelines are scaffold-test artifacts', () => {
    for (const f of genFiles) expect(isScaffoldTestArtifact(basename(f))).toBe(false);
    for (const f of pipelineFiles) expect(isScaffoldTestArtifact(basename(f))).toBe(false);
  });
});
