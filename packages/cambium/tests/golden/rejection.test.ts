/**
 * Golden IR corpus — rejection tests (DEC-005 / DEC-006 / DEC-007a).
 *
 * For each case in rejection-cases.ts: write the DSL to a temp file,
 * invoke compile.rb, assert (a) non-zero exit, (b) stderr includes the
 * expected message substring, (c) stderr includes the expected exception
 * class. Never snapshot raw stderr — it carries absolute paths and line
 * numbers that drift across machines and source edits (DEC-005).
 *
 * Run offline: `npm run test:golden` — no LLM, no secrets.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cases } from './rejection-cases.js'

const REPO_ROOT = process.cwd()
const COMPILE = 'ruby/cambium/compile.rb'

describe('golden IR corpus — rejection', () => {
  // Collect temp dirs created during the suite for cleanup.
  const tempDirs: string[] = []

  afterEach(() => {
    // Clean up the most recently created temp dir after each test.
    const dir = tempDirs.pop()
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it.each(cases.map(c => [c.name, c] as [string, typeof c]))(
    '%s',
    (_name, tc) => {
      const dir = mkdtempSync(join(tmpdir(), 'cambium-golden-rejection-'))
      tempDirs.push(dir)

      const filename = tc.filename ?? 'test_gen.cmb.rb'
      const tmpFile = join(dir, filename)
      writeFileSync(tmpFile, tc.dsl)

      const args = [COMPILE, tmpFile, ...(tc.method ? ['--method', tc.method] : [])]
      const result = spawnSync('ruby', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 1 * 1024 * 1024,
      })

      expect(result.status, `Expected non-zero exit for case '${_name}'`).not.toBe(0)
      expect(
        result.stderr,
        `Expected stderr to include error class '${tc.expectClass}' for case '${_name}'`,
      ).toContain(tc.expectClass)
      expect(
        result.stderr,
        `Expected stderr to include message '${tc.expectMessage}' for case '${_name}'`,
      ).toContain(tc.expectMessage)
    },
  )
})
