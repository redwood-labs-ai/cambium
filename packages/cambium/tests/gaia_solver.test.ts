import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

describe('GaiaSolver', () => {
  it('compiles to valid IR', () => {
    // TODO: create a fixture and uncomment
    // const ir = JSON.parse(execSync(
    //   'ruby ruby/cambium/compile.rb packages/cambium/app/gens/gaia_solver.cmb.rb --method analyze --arg <fixture>',
    //   { encoding: 'utf8' },
    // ))
    // expect(ir.entry.class).toBe('GaiaSolver')
    expect(true).toBe(true)
  })
})
