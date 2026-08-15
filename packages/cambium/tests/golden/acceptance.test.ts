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

/** List all files in dir ending with ext, sorted, full absolute paths. */
function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(ext))
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
