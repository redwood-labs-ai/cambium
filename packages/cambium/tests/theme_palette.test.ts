/**
 * ThemePalette — golden regression test (RED-140), scaffolded by
 * `cambium new agent ThemePalette` (#200 STEP-001) and edited for
 * #200's actual shape (DEC-200-009).
 *
 * #205 (DEC-006): before #205, `mockGenerate` only special-cased a fixed
 * list of framework schema ids (`MemoryWrites`, `CambiumDiffAnalysis`,
 * `CambiumCiReview`) plus a generic `AnalysisReport`-shaped default —
 * there was no `ThemePaletteOutput` branch, so a plain `--mock` run
 * always came back missing all 26 required fields and Validate always
 * failed, even after repair. That was pinned as the actual deterministic
 * behavior in this file (see git history for the old text). #205's
 * schema-derived mock (`mock-output.ts`) removes that limitation: the
 * walker derives a placeholder value for every declared property, so
 * Generate now comes back schema-valid on the first attempt.
 *
 * What this golden proves: shape and determinism — a real 26-key
 * `returns do … end` schema now round-trips through `--mock` to a
 * schema-valid candidate, and the correctors + repair loop run against
 * it exactly as they would against a real model's output. What it does
 * NOT prove: quality. The mock's placeholder strings (`"mock red"`,
 * etc.) are not valid colors, so `hex_normalize` flags every one of them
 * as unparseable (error severity — feeds Repair), repair's own mock
 * reply is equally placeholder-shaped, and the run ends in
 * `CorrectAcceptedWithErrors` (RED-298's graceful degrade) rather than a
 * clean palette. That is the expected, deterministic snapshot for this
 * gen under mock — see `theme_palette_repair_loop.test.ts` for the
 * "valid palette out of a healthy candidate" and "contrast_floor /
 * hex_normalize genuinely feed Repair" claims, proven directly against
 * hand-authored candidates via `cambium replay --edit` rather than
 * depending on what the mock happens to produce.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { goldenTest, normalizeStrings } from '../../cambium-runner/src/golden.js'

const REPO_ROOT = process.cwd()
// How to invoke the CLI from this workspace. In-tree Cambium repo: run the CLI entrypoint directly.
const CAMBIUM: string[] = ['node', join(REPO_ROOT, 'cli/cambium.mjs')]
const GEN = join(REPO_ROOT, 'packages/cambium/app/gens/theme_palette.cmb.rb')
const FIXTURE = join(REPO_ROOT, 'packages/cambium/examples/fixtures/omarchy_swatches.json')
const SNAPSHOT = join(REPO_ROOT, 'packages/cambium/examples/fixtures/theme_palette-snapshot.json')

function runMock() {
  const [bin, ...pre] = CAMBIUM
  return spawnSync(
    bin,
    [...pre, 'run', GEN, '--method', 'generate_palette', '--arg', FIXTURE, '--mock'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
}

// Derive the run directory from the announcement line `cambium run`
// always writes to stderr, first thing, on success AND failure:
// `[cambium] run <run_id> dir=<path> trace=<path>`.
function runDirFromStderr(stderr: string): string | null {
  const m = stderr.match(/\[cambium\] run \S+ dir=(\S+)/)
  return m ? m[1] : null
}

describe('ThemePalette', () => {
  it('compiles to valid IR', () => {
    // Compile via the CLI rather than spawning ruby against a
    // `ruby/cambium/compile.rb` path: only the Cambium repo itself has
    // that directory. The CLI resolves the compiler relative to its own
    // install (RED-274), so this works in any workspace.
    const irOut = join(tmpdir(), `theme_palette-${process.pid}.ir.json`)
    const [bin, ...pre] = CAMBIUM
    const result = spawnSync(
      bin,
      [...pre, 'compile', GEN, '--method', 'generate_palette', '-o', irOut],
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    expect(result.status, `Compile failed:\n${result.stderr}`).toBe(0)
    const ir = JSON.parse(readFileSync(irOut, 'utf8'))
    try { rmSync(irOut, { force: true }) } catch {}
    expect(ir.entry.class).toBe('ThemePalette')
    expect(ir.entry.method).toBe('generate_palette')
    // The full §8.2 26-key inline schema, in order (RED-419).
    expect(Object.keys(ir.returnSchema.properties)).toHaveLength(26)
  })

  it('#205 (DEC-006): a --mock run derives a schema-valid candidate, ending accepted-with-errors (mock golden — shape + determinism, not quality)', () => {
    const result = runMock()
    expect(result.status, `Gen failed:\n${result.stderr}`).toBe(0)

    const actual = JSON.parse(result.stdout)
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const { passed, summary } = goldenTest(actual, expected, {
      normalizers: [normalizeStrings],
    })
    expect(passed, summary).toBe(true)

    // Full 26-key shape; enum-first precedence picked "dark" for `mode`.
    expect(Object.keys(actual)).toHaveLength(26)
    expect(actual.mode).toBe('dark')

    const runDir = runDirFromStderr(result.stderr)
    expect(runDir).not.toBeNull()
    const trace = JSON.parse(readFileSync(join(runDir!, 'trace.json'), 'utf8'))
    expect(trace.final?.ok).toBe(true)

    // hex_normalize flags every placeholder string as an unparseable
    // color (error severity — the mock's `"mock red"` etc. are not
    // colors), which feeds Repair; repair's own reply is equally
    // placeholder-shaped, so the run ends in the RED-298 graceful-degrade
    // step rather than a clean palette.
    const types = trace.steps.map((s: any) => s.type)
    const hexCorrect = trace.steps.find((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('hex_normalize'))
    expect(hexCorrect?.meta?.issues?.some((i: any) => i.severity === 'error')).toBe(true)
    expect(types).toContain('Repair')
    expect(types).toContain('CorrectAcceptedWithErrors')

    if (runDir) try { rmSync(runDir, { recursive: true, force: true }) } catch {}
  })

  it('#205: the mock golden is deterministic (identical output across two runs)', () => {
    const first = runMock()
    expect(first.status).toBe(0)
    const runDir1 = runDirFromStderr(first.stderr)

    const second = runMock()
    expect(second.status).toBe(0)
    const runDir2 = runDirFromStderr(second.stderr)

    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout))

    if (runDir1) try { rmSync(runDir1, { recursive: true, force: true }) } catch {}
    if (runDir2) try { rmSync(runDir2, { recursive: true, force: true }) } catch {}
  })
})
