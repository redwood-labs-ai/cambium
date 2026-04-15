import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-210: `returns <Schema>` typos should fail at compile time, not
 * leak through to the runner.
 */
describe('compile-time schema validation (RED-210)', () => {
  it('rejects an unknown schema name with a helpful error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red210-'))
    const gen = join(dir, 'typo.cmb.rb')
    writeFileSync(gen, `
class TypoGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisRepor
  def go(x)
    generate "x" do
      returns AnalysisRepor
    end
  end
end
`.trim())

    let stderr = ''
    try {
      execSync(
        `ruby ruby/cambium/compile.rb ${gen} --method go --arg packages/cambium/examples/fixtures/incident.txt`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
      throw new Error('Expected compile to fail, but it succeeded')
    } catch (e: any) {
      stderr = String(e.stderr ?? '') + String(e.message ?? '')
    } finally {
      unlinkSync(gen)
    }

    // Error message should name the typo, say it's unknown, list the
    // available schemas, and suggest the closest match.
    expect(stderr).toMatch(/Unknown schema 'AnalysisRepor'/)
    expect(stderr).toMatch(/Available schemas/)
    expect(stderr).toMatch(/AnalysisReport/)
    expect(stderr).toMatch(/Did you mean 'AnalysisReport'\?/)
  })

  it('accepts a valid schema name', () => {
    // The existing analyst gen uses `returns AnalysisReport` — if this
    // compiled before RED-210, it should still compile after.
    const ir = JSON.parse(execSync(
      'ruby ruby/cambium/compile.rb packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/incident.txt',
      { encoding: 'utf8' },
    ))
    expect(ir.returnSchemaId).toBe('AnalysisReport')
  })
})
