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

  // ── RED-287: engine-mode schemas.ts is a first-class candidate ────

  it('engine mode: validates returns against <engineDir>/schemas.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red287-schemas-'))
    writeFileSync(join(dir, 'cambium.engine.json'), '{}')
    writeFileSync(join(dir, 'schemas.ts'), `
import { Type } from '@sinclair/typebox';
export const EngineReport = Type.Object({ summary: Type.String() }, { additionalProperties: false, $id: 'EngineReport' });
`.trim())
    const gen = join(dir, 'engine_gen.cmb.rb')
    writeFileSync(gen, `
class EngineGen < GenModel
  model "omlx:stub"
  system "inline"
  returns EngineReport
  def go(x)
    generate "x" do
      returns EngineReport
    end
  end
end
`.trim())
    const ir = JSON.parse(execSync(
      `ruby ruby/cambium/compile.rb ${gen} --method go --arg packages/cambium/examples/fixtures/incident.txt`,
      { encoding: 'utf8' },
    ))
    expect(ir.returnSchemaId).toBe('EngineReport')
  })

  it('engine mode: rejects a typo with the engine schemas.ts exports in the available list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red287-schemas-typo-'))
    writeFileSync(join(dir, 'cambium.engine.json'), '{}')
    writeFileSync(join(dir, 'schemas.ts'), `
import { Type } from '@sinclair/typebox';
export const PriceReport = Type.Object({ avg: Type.Number() }, { additionalProperties: false, $id: 'PriceReport' });
`.trim())
    const gen = join(dir, 'engine_typo.cmb.rb')
    writeFileSync(gen, `
class EngineTypoGen < GenModel
  model "omlx:stub"
  system "inline"
  returns PriceRepor
  def go(x)
    generate "x" do
      returns PriceRepor
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
    }
    expect(stderr).toMatch(/Unknown schema 'PriceRepor'/)
    // PriceReport is from the engine's schemas.ts — must surface in the list.
    expect(stderr).toMatch(/PriceReport/)
    expect(stderr).toMatch(/Did you mean 'PriceReport'\?/)
  })
})
