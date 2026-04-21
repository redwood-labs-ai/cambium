/**
 * RED-298: compile-time validation of `corrects :name, max_attempts: N`.
 *
 * The Ruby DSL enforces max_attempts ∈ 1..3 at class-load time (same
 * stance as RED-239's MAX_TTL_SECONDS). Catches the foot-gun where a
 * gen author writes `max_attempts: 99` in frustration and would
 * otherwise burn through their budget in silence.
 *
 * Also asserts the IR shape: correctors are emitted as
 * `Array<{ name, max_attempts }>`, not the pre-RED-298 `Array<string>`.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt'

function compile(gen: string): { ir: any | null; stderr: string } {
  const repoRoot = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red298-'))
  const genPath = join(dir, 'g.cmb.rb')
  writeFileSync(genPath, gen.trim())
  try {
    const stdout = execSync(
      `ruby ${repoRoot}/ruby/cambium/compile.rb ${genPath} --method analyze --arg ${repoRoot}/${FIXTURE}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: dir },
    )
    return { ir: JSON.parse(stdout), stderr: '' }
  } catch (e: any) {
    return { ir: null, stderr: String(e.stderr ?? '') + String(e.message ?? '') }
  }
}

const GEN = (body: string) => `
class G < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  ${body}

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`

describe('corrects max_attempts (RED-298)', () => {
  it('emits Array<{name, max_attempts}> with default max_attempts: 1', () => {
    const { ir, stderr } = compile(GEN('corrects :math'))
    expect(stderr).toBe('')
    expect(ir?.policies?.correctors).toEqual([{ name: 'math', max_attempts: 1 }])
  })

  it('honors max_attempts: 3', () => {
    const { ir, stderr } = compile(GEN('corrects :math, max_attempts: 3'))
    expect(stderr).toBe('')
    expect(ir?.policies?.correctors).toEqual([{ name: 'math', max_attempts: 3 }])
  })

  it('applies max_attempts to every symbol in the same call', () => {
    const { ir, stderr } = compile(GEN('corrects :math, :dates, max_attempts: 2'))
    expect(stderr).toBe('')
    expect(ir?.policies?.correctors).toEqual([
      { name: 'math', max_attempts: 2 },
      { name: 'dates', max_attempts: 2 },
    ])
  })

  it('concats multiple corrects calls with different max_attempts', () => {
    const { ir, stderr } = compile(
      GEN('corrects :math, max_attempts: 1\n  corrects :dates, max_attempts: 3'),
    )
    expect(stderr).toBe('')
    expect(ir?.policies?.correctors).toEqual([
      { name: 'math', max_attempts: 1 },
      { name: 'dates', max_attempts: 3 },
    ])
  })

  it('rejects max_attempts: 0 with a clear error', () => {
    const { ir, stderr } = compile(GEN('corrects :math, max_attempts: 0'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/max_attempts.*1\.\.3/)
  })

  it('rejects max_attempts: 4 (exceeds the ceiling)', () => {
    const { ir, stderr } = compile(GEN('corrects :math, max_attempts: 4'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/max_attempts.*1\.\.3/)
  })

  it('rejects a non-integer max_attempts', () => {
    const { ir, stderr } = compile(GEN('corrects :math, max_attempts: "3"'))
    expect(ir).toBeNull()
    expect(stderr).toMatch(/max_attempts.*Integer/)
  })
})
