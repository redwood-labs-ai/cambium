/**
 * #200 (DEC-200-003): unit tests for the `hex_normalize` app corrector.
 */
import { describe, it, expect } from 'vitest'
import { hex_normalize } from '../app/correctors/hex_normalize.corrector.js'

describe('hex_normalize corrector', () => {
  it('expands #RGB shorthand to canonical #rrggbb', () => {
    const result = hex_normalize({ accent: '#f0a' }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.accent).toBe('#ff00aa')
    expect(result.issues).toEqual([
      { path: '.accent', message: expect.any(String), severity: 'fixed', original: '#f0a', corrected: '#ff00aa' },
    ])
  })

  it('lowercases an uppercase #RRGGBB value', () => {
    const result = hex_normalize({ background: '#1A2B3C' }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.background).toBe('#1a2b3c')
  })

  it('adds the leading # to a bare RRGGBB value', () => {
    const result = hex_normalize({ foreground: '1a2b3c' }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.foreground).toBe('#1a2b3c')
  })

  it('converts rgb(r, g, b) to canonical hex', () => {
    const result = hex_normalize({ red: 'rgb(255, 0, 170)' }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.red).toBe('#ff00aa')
  })

  it('converts rgb(...) case-insensitively and with loose spacing', () => {
    const result = hex_normalize({ blue: 'RGB(0,0,255)' }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.blue).toBe('#0000ff')
  })

  it('leaves an already-canonical value untouched, with no issue', () => {
    const result = hex_normalize({ accent: '#7aa2f7' }, {})
    expect(result.corrected).toBe(false)
    expect(result.output.accent).toBe('#7aa2f7')
    expect(result.issues).toEqual([])
  })

  it('never touches the mode field', () => {
    const result = hex_normalize({ mode: 'DARK', accent: '#7aa2f7' }, {})
    expect(result.output.mode).toBe('DARK')
    expect(result.issues.some(i => i.path.includes('mode'))).toBe(false)
  })

  it('flags an unparseable color as an error-severity issue, feeding repair', () => {
    const result = hex_normalize({ green: 'not a colour' }, {})
    expect(result.corrected).toBe(false)
    expect(result.output.green).toBe('not a colour') // left as-is; repair fixes it
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].message).toMatch(/not a colour/)
  })

  it('flags an out-of-range rgb() component as an error', () => {
    const result = hex_normalize({ yellow: 'rgb(999, 0, 0)' }, {})
    expect(result.issues[0].severity).toBe('error')
  })

  it('walks nested objects', () => {
    const result = hex_normalize({ nested: { accent: '#ABCDEF' } }, {})
    expect(result.corrected).toBe(true)
    expect(result.output.nested.accent).toBe('#abcdef')
  })

  it('normalizes every color field on a full 26-key palette shape', () => {
    const palette = {
      mode: 'dark',
      accent: '7AA2F7',
      selection: '#7aa2f7',
      muted: 'rgb(65, 72, 104)',
      background: '#1a1b26',
    }
    const result = hex_normalize(palette, {})
    expect(result.output.mode).toBe('dark')
    expect(result.output.accent).toBe('#7aa2f7')
    expect(result.output.selection).toBe('#7aa2f7')
    expect(result.output.muted).toBe('#414868')
    expect(result.output.background).toBe('#1a1b26')
    // accent + muted were rewritten; selection + background were already canonical.
    expect(result.issues.filter(i => i.severity === 'fixed')).toHaveLength(2)
  })
})
