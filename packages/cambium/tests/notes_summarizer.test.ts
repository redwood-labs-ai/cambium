/**
 * NotesSummarizer — golden regression test (RED-140 shape), added on #205
 * (STEP-004) for the #169 example gen.
 *
 * What this golden proves (#205, DEC-006): a `returns do … end` block
 * with an array-of-objects field that itself nests an array-of-objects
 * (`highlights[].citations[]`) round-trips through `--mock` to a
 * schema-valid candidate on the first Generate — the walker in
 * `mock-output.ts` emits one placeholder element per array level, so
 * the full nested shape is present and Validate never fails. Before
 * #205 there was no `NotesSummarizerOutput` branch in `mockGenerate`,
 * so the gen came back `AnalysisReport`-shaped, failed validation, and
 * exited 1.
 *
 * It also pins the #169 wiring end to end: `from:` ends in `.md`, so the
 * compiler infers `format: "markdown"`, and the trace's `GroundingCheck`
 * carries `format: "markdown", derived: true` — the verifier ran against
 * the derived plain-text view as well as the raw Markdown.
 *
 * What it does NOT prove: that citations verify. The mock's placeholder
 * quote (`"mock quote"`) is not in the release notes, so the citation
 * check fails, the grounding repair (whose own mock reply is identical)
 * cannot fix it, and `GroundingCheckAfterRepair` is `ok: false` with
 * `citations_before === citations_after` — nothing was deleted, so the
 * RED-175 fail-closed guard does not trip and the run ends `ok: true`
 * with the failure recorded in the trace. That "reported, not fatal"
 * outcome for a non-deleting grounding failure is the runner's
 * pre-existing contract, pinned here as observed, not endorsed. The
 * "quotes from bold spans / links / table rows verify" claim is proven
 * directly in `packages/cambium-runner/src/grounding-text.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { goldenTest, normalizeStrings } from '../../cambium-runner/src/golden.js'

const REPO_ROOT = process.cwd()
// How to invoke the CLI from this workspace. In-tree Cambium repo: run the CLI entrypoint directly.
const CAMBIUM: string[] = ['node', join(REPO_ROOT, 'cli/cambium.mjs')]
const GEN = join(REPO_ROOT, 'packages/cambium/app/gens/notes_summarizer.cmb.rb')
const FIXTURE = join(REPO_ROOT, 'packages/cambium/examples/fixtures/release_notes.md')
const SNAPSHOT = join(REPO_ROOT, 'packages/cambium/examples/fixtures/notes_summarizer-snapshot.json')

function runMock() {
  const [bin, ...pre] = CAMBIUM
  return spawnSync(
    bin,
    [...pre, 'run', GEN, '--method', 'summarize', '--arg', FIXTURE, '--mock'],
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

describe('NotesSummarizer', () => {
  it('compiles to valid IR with the #169 inferred markdown format', () => {
    const irOut = join(tmpdir(), `notes_summarizer-${process.pid}.ir.json`)
    const [bin, ...pre] = CAMBIUM
    const result = spawnSync(
      bin,
      [...pre, 'compile', GEN, '--method', 'summarize', '-o', irOut],
      { encoding: 'utf8', cwd: REPO_ROOT },
    )
    expect(result.status, `Compile failed:\n${result.stderr}`).toBe(0)
    const ir = JSON.parse(readFileSync(irOut, 'utf8'))
    try { rmSync(irOut, { force: true }) } catch {}
    expect(ir.entry.class).toBe('NotesSummarizer')
    expect(ir.entry.method).toBe('summarize')
    expect(ir.policies.grounding.source).toBe('notes')
    expect(ir.policies.grounding.require_citations).toBe(true)
    // #169: `from: "….md"` → format inferred at compile time, no kwarg written.
    expect(ir.policies.grounding.format).toBe('markdown')
    // Inline schema (RED-419): top-level keys, and the nested array-of-object chain.
    expect(Object.keys(ir.returnSchema.properties)).toEqual(['summary', 'highlights'])
    expect(ir.returnSchema.properties.highlights.items.properties.citations.items.properties.quote.type).toBe('string')
  })

  it('#205 (DEC-006): a --mock run derives a schema-valid nested candidate; the placeholder quote fails grounding without failing the run (mock golden — shape + determinism, not quality)', () => {
    const result = runMock()
    expect(result.status, `Gen failed:\n${result.stderr}`).toBe(0)

    const actual = JSON.parse(result.stdout)
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const { passed, summary } = goldenTest(actual, expected, {
      normalizers: [normalizeStrings],
    })
    expect(passed, summary).toBe(true)

    // Full nested shape: one placeholder element per array level.
    expect(Object.keys(actual)).toEqual(['summary', 'highlights'])
    expect(actual.highlights).toHaveLength(1)
    expect(actual.highlights[0].citations).toHaveLength(1)
    expect(actual.highlights[0].citations[0].quote).toBe('mock quote')

    const runDir = runDirFromStderr(result.stderr)
    expect(runDir).not.toBeNull()
    const trace = JSON.parse(readFileSync(join(runDir!, 'trace.json'), 'utf8'))
    expect(trace.final?.ok).toBe(true)

    // Schema-valid on the first attempt: Generate is ok and the very
    // next step is the grounding check — no schema repair in between.
    const types = trace.steps.map((s: any) => s.type)
    expect(types).toEqual([
      'SecurityCheck',
      'Generate',
      'GroundingCheck',
      'Repair',
      'ValidateAfterGrounding',
      'GroundingCheckAfterRepair',
    ])
    expect(trace.steps[1].ok).toBe(true)

    // #169 wiring: the inferred format reached the verifier.
    const gc = trace.steps.find((s: any) => s.type === 'GroundingCheck')
    expect(gc.ok).toBe(false)
    expect(gc.meta.format).toBe('markdown')
    expect(gc.meta.derived).toBe(true)
    expect(gc.meta.totalChecked).toBe(1)
    expect(gc.meta.failed).toBe(1)

    // RED-175: the repair did not delete the citation, so the failure is
    // recorded rather than fatal.
    const after = trace.steps.find((s: any) => s.type === 'GroundingCheckAfterRepair')
    expect(after.ok).toBe(false)
    expect(after.meta.citations_before).toBe(1)
    expect(after.meta.citations_after).toBe(1)
    expect(after.meta.deleted_by_repair).toBe(false)

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
