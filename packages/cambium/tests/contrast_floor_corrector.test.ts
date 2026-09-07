/**
 * #200 (DEC-200-004): unit tests for the `contrast_floor` app corrector.
 *
 * Requires canonical `#rrggbb` (DEC-200-005: this corrector runs after
 * `hex_normalize` in the gen, so every value it sees is already
 * canonical in real runs — these tests pass canonical hex directly).
 */
import { describe, it, expect } from 'vitest'
import { contrast_floor } from '../app/correctors/contrast_floor.corrector.js'

describe('contrast_floor corrector', () => {
  it('produces no issues for a high-contrast, well-formed palette', () => {
    const result = contrast_floor({
      foreground: '#ffffff',
      bright_foreground: '#ffffff',
      background: '#000000',
      light_foreground: '#ffffff',
      dark_background: '#000000',
      muted: '#444444',
    }, {})
    expect(result.issues).toEqual([])
    expect(result.corrected).toBe(false)
  })

  it('flags foreground/background and bright_foreground/background as errors when too close', () => {
    const result = contrast_floor({
      foreground: '#909090',
      bright_foreground: '#1a1b26',
      background: '#808080',
      light_foreground: '#c0caf5',
      dark_background: '#1a1b26',
      muted: '#7a7a7a',
    }, {})

    const errors = result.issues.filter(i => i.severity === 'error')
    expect(errors).toHaveLength(2)

    const fgIssue = errors.find(i => i.path === 'foreground,background')
    expect(fgIssue).toBeDefined()
    // Message names both fields, both values, the computed ratio, and the floor.
    expect(fgIssue!.message).toMatch(/foreground/)
    expect(fgIssue!.message).toMatch(/background/)
    expect(fgIssue!.message).toMatch(/#909090/)
    expect(fgIssue!.message).toMatch(/#808080/)
    expect(fgIssue!.message).toMatch(/1\.24/)
    expect(fgIssue!.message).toMatch(/4\.5/)

    const brightIssue = errors.find(i => i.path === 'bright_foreground,background')
    expect(brightIssue).toBeDefined()
  })

  it('does not flag light_foreground/dark_background when it clears the 3.0 floor', () => {
    const result = contrast_floor({
      foreground: '#909090',
      bright_foreground: '#1a1b26',
      background: '#808080',
      light_foreground: '#c0caf5',
      dark_background: '#1a1b26',
      muted: '#7a7a7a',
    }, {})
    expect(result.issues.some(i => i.path === 'light_foreground,dark_background')).toBe(false)
  })

  it('flags a low-contrast muted/background pair as a warning, never an error', () => {
    const result = contrast_floor({
      foreground: '#909090',
      bright_foreground: '#1a1b26',
      background: '#808080',
      light_foreground: '#c0caf5',
      dark_background: '#1a1b26',
      muted: '#7a7a7a',
    }, {})
    const mutedIssue = result.issues.find(i => i.path === 'muted,background')
    expect(mutedIssue).toBeDefined()
    expect(mutedIssue!.severity).toBe('warning')
  })

  it('never rewrites values — repair, not this corrector, picks a new color', () => {
    const input = { foreground: '#909090', background: '#808080' }
    const result = contrast_floor(input, {})
    expect(result.output).toBe(input)
    expect(result.output.foreground).toBe('#909090')
  })

  it('skips a pair when a field is missing rather than throwing', () => {
    expect(() => contrast_floor({ foreground: '#ffffff' }, {})).not.toThrow()
    const result = contrast_floor({ foreground: '#ffffff' }, {})
    expect(result.issues).toEqual([])
  })

  it('skips a pair when a field is not canonical hex (hex_normalize already flagged it)', () => {
    const result = contrast_floor({ foreground: 'not a colour', background: '#000000' }, {})
    expect(result.issues).toEqual([])
  })
})
