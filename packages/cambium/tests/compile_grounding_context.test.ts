import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * RED-276: the IR's `context` key should match the `grounded_in :name`
 * declaration. Before this fix the compiler always emitted
 * `context: { document: arg }`, which broke the source-lookup for any
 * gen whose grounding source wasn't literally `document`.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt'

function compile(genPath: string, method: string, arg: string): any {
  const stdout = execSync(
    `ruby ./ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${arg}`,
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout)
}

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red276-'))
  const path = join(dir, 'grounded.cmb.rb')
  writeFileSync(path, body.trim())
  return path
}

describe('grounding source as context key (RED-276)', () => {
  it('uses `grounded_in :foo` as the context key', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:test"
  system "inline"
  returns AnalysisReport
  grounded_in :linear_issue, require_citations: false

  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.policies.grounding).toEqual({
      source: 'linear_issue',
      require_citations: false,
    })
    expect(Object.keys(ir.context)).toEqual(['linear_issue'])
    expect(typeof ir.context.linear_issue).toBe('string')
    expect(ir.context.linear_issue.length).toBeGreaterThan(0)
  })

  it('preserves the `document` key when no grounding is declared', () => {
    const gen = writeGen(`
class Ungrounded < GenModel
  model "omlx:test"
  system "inline"
  returns AnalysisReport

  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.policies.grounding).toBeNull()
    expect(Object.keys(ir.context)).toEqual(['document'])
  })

  it('preserves the `document` key for a gen using `grounded_in :document` (analyst back-compat)', () => {
    const gen = writeGen(`
class AnalystLike < GenModel
  model "omlx:test"
  system "inline"
  returns AnalysisReport
  grounded_in :document, require_citations: true

  def analyze(x)
    generate "x" do
      returns AnalysisReport
    end
  end
end
`)
    const ir = compile(gen, 'analyze', FIXTURE_ARG)
    expect(ir.policies.grounding.source).toBe('document')
    expect(Object.keys(ir.context)).toEqual(['document'])
  })
})
