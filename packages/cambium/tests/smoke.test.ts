import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

describe('smoke', () => {
  it('compiles the analyst DSL to valid IR', () => {
    const ir = JSON.parse(execSync(
      'ruby ruby/cambium/compile.rb packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/incident.txt',
      { encoding: 'utf8' },
    ))

    expect(ir.version).toBe('0.2')
    expect(ir.entry.class).toBe('Analyst')
    expect(ir.returnSchemaId).toBe('AnalysisReport')
    expect(ir.policies.tools_allowed).toContain('calculator')
    // RED-298: correctors are now { name, max_attempts } objects, not bare strings.
    expect(ir.policies.correctors).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'math' })]),
    )
    expect(ir.signals).toHaveLength(1)
    expect(ir.triggers).toHaveLength(1)
    expect(ir.steps).toHaveLength(1)
    expect(ir.steps[0].type).toBe('Generate')
    expect(ir.system).toBeTruthy()
  })
})
