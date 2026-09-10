/**
 * MenuEntry — golden regression test (RED-140), scaffolded by
 * `cambium new agent MenuEntry` (#201 STEP-001) and edited for #201's
 * actual shape.
 *
 * #205 (DEC-006): `mockGenerate` derives a placeholder value for EVERY
 * declared schema property, required or not — so under `--mock` this
 * gen's optional `action` and `target` BOTH come back set
 * (`"mock action"` / `"mock target"`). That is exactly the
 * `menu_model_check` corrector's "wrong inferred kind" trigger, with no
 * fixture engineering needed: a plain `--mock` run of this gen
 * deterministically exercises the corrector's error path and the repair
 * loop, and the trace is the evidence (see the second test below).
 *
 * What this golden proves: shape, determinism, and that the corrector
 * genuinely fires against real (if placeholder) model output — not just
 * shape and determinism the way a corrector-free golden would. What it
 * does NOT prove: a completed heal — repair's own mock reply is equally
 * placeholder-shaped (both `action`/`target` set again), so the run
 * ends in `CorrectAcceptedWithErrors` rather than a clean, single-field
 * entry. See `menu_entry_repair_loop.test.ts` for the healthy-candidate
 * (clears clean, no Repair) and ambiguous-candidate (Repair fires)
 * claims proven directly against hand-authored candidates via
 * `cambium replay --edit`, matching the `theme_palette` (#200)
 * precedent's DEC-200-009 approach.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { goldenTest, normalizeStrings } from '../../cambium-runner/src/golden.js'

const REPO_ROOT = process.cwd()
const CAMBIUM: string[] = ['node', join(REPO_ROOT, 'cli/cambium.mjs')]
const GEN = join(REPO_ROOT, 'packages/cambium/app/gens/menu_entry.cmb.rb')
const FIXTURE = join(REPO_ROOT, 'packages/cambium/examples/fixtures/menu_entry_request.json')
const SNAPSHOT = join(REPO_ROOT, 'packages/cambium/examples/fixtures/menu_entry-snapshot.json')

function runMock() {
  const [bin, ...pre] = CAMBIUM
  return spawnSync(
    bin,
    [...pre, 'run', GEN, '--method', 'propose_entry', '--arg', FIXTURE, '--mock'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
}

// `cambium run` announces the run dir on stderr, first thing, on success
// AND failure: `[cambium] run <run_id> dir=<path> trace=<path>`.
function runDirFromStderr(stderr: string): string | null {
  const m = stderr.match(/\[cambium\] run \S+ dir=(\S+)/)
  return m ? m[1] : null
}

describe('MenuEntry', () => {
  it('compiles to valid IR', () => {
    const irOut = join(tmpdir(), `menu_entry-${process.pid}.ir.json`)
    const [bin, ...pre] = CAMBIUM
    const result = spawnSync(
      bin,
      [...pre, 'compile', GEN, '--method', 'propose_entry', '-o', irOut],
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    expect(result.status, `Compile failed:\n${result.stderr}`).toBe(0)
    const ir = JSON.parse(readFileSync(irOut, 'utf8'))
    try { rmSync(irOut, { force: true }) } catch {}
    expect(ir.entry.class).toBe('MenuEntry')
    expect(ir.entry.method).toBe('propose_entry')
    expect(Object.keys(ir.returnSchema.properties).sort()).toEqual(
      ['action', 'checked', 'disabled', 'id', 'label', 'target', 'when'],
    )
    expect(ir.returnSchema.required).toEqual(['id', 'label'])
    expect(ir.policies.correctors).toEqual([{ name: 'menu_model_check', max_attempts: 1 }])
  })

  it('a --mock run derives a both-action-and-target candidate; menu_model_check catches it and Repair fires (mock golden — shape + determinism, not a completed heal)', () => {
    const result = runMock()
    expect(result.status, `Gen failed:\n${result.stderr}`).toBe(0)

    const actual = JSON.parse(result.stdout)
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const { passed, summary } = goldenTest(actual, expected, {
      normalizers: [normalizeStrings],
    })
    expect(passed, summary).toBe(true)

    const runDir = runDirFromStderr(result.stderr)
    expect(runDir).not.toBeNull()
    const trace = JSON.parse(readFileSync(join(runDir!, 'trace.json'), 'utf8'))
    expect(trace.final?.ok).toBe(true)

    // menu_model_check flags the mock's both-action-and-target candidate
    // as an error-severity "wrong inferred kind" issue, which feeds
    // Repair; repair's own reply is equally placeholder-shaped, so the
    // run ends in the RED-298 graceful-degrade step rather than a clean
    // single-field entry.
    const types = trace.steps.map((s: any) => s.type)
    const correct = trace.steps.find((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('menu_model_check'))
    expect(correct?.meta?.issues?.some((i: any) => i.severity === 'error' && i.path === 'action,target')).toBe(true)
    expect(types).toContain('Repair')
    expect(types).toContain('CorrectAcceptedWithErrors')

    if (runDir) try { rmSync(runDir, { recursive: true, force: true }) } catch {}
  })

  it('the mock golden is deterministic (identical output across two runs)', () => {
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
