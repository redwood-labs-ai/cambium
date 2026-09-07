/**
 * #200 (DEC-200-006): unit tests for the `colors.toml` emitter.
 */
import { describe, it, expect } from 'vitest'
import { renderColorsToml, COLORS_TOML_KEYS } from '../examples/omarchy/render-colors-toml.mjs'

// A well-formed 26-key palette object, spec §8.2 shape.
const GOLDEN_PALETTE = {
  mode: 'dark',
  accent: '#7aa2f7',
  selection: '#33467c',
  muted: '#565f89',
  background: '#1a1b26',
  dark_background: '#16161e',
  darker_background: '#101014',
  lighter_background: '#24283b',
  foreground: '#c0caf5',
  dark_foreground: '#a9b1d6',
  light_foreground: '#d5d6db',
  bright_foreground: '#ffffff',
  red: '#f7768e',
  yellow: '#e0af68',
  orange: '#ff9e64',
  green: '#9ece6a',
  cyan: '#7dcfff',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  brown: '#8b6b4a',
  bright_red: '#ff7a93',
  bright_yellow: '#e6b673',
  bright_green: '#a8d876',
  bright_cyan: '#89d7ff',
  bright_blue: '#8bb1ff',
  bright_magenta: '#c6a3ff',
}

describe('renderColorsToml (DEC-200-006)', () => {
  it('has exactly the 26 §8.2 keys, no bright_orange / bright_brown', () => {
    expect(COLORS_TOML_KEYS).toHaveLength(26)
    expect(COLORS_TOML_KEYS).not.toContain('bright_orange')
    expect(COLORS_TOML_KEYS).not.toContain('bright_brown')
  })

  it('emits every key in the fixed §8.2 order', () => {
    const toml = renderColorsToml(GOLDEN_PALETTE)
    const emittedKeys = toml
      .split('\n')
      .filter((line) => line.includes(' = '))
      .map((line) => line.split(' = ')[0])
    expect(emittedKeys).toEqual(COLORS_TOML_KEYS)
  })

  it('double-quotes every value', () => {
    const toml = renderColorsToml(GOLDEN_PALETTE)
    for (const line of toml.split('\n')) {
      if (!line.includes(' = ')) continue
      expect(line).toMatch(/^\w+ = "[^"]*"$/)
    }
  })

  it('separates the six §8.2 groups with exactly one blank line', () => {
    const toml = renderColorsToml(GOLDEN_PALETTE)
    const blankLineGroups = toml.trimEnd().split('\n\n')
    expect(blankLineGroups).toHaveLength(6)
    expect(blankLineGroups[0]).toBe('mode = "dark"')
    expect(blankLineGroups[1].split('\n')).toEqual(['accent = "#7aa2f7"', 'selection = "#33467c"', 'muted = "#565f89"'])
  })

  it('is stable on round-trip: rendering twice produces byte-identical output', () => {
    expect(renderColorsToml(GOLDEN_PALETTE)).toBe(renderColorsToml({ ...GOLDEN_PALETTE }))
  })

  it('rejects an object missing a required key', () => {
    const { mode, ...rest } = GOLDEN_PALETTE
    expect(() => renderColorsToml(rest)).toThrow(/missing key/)
    expect(() => renderColorsToml(rest)).toThrow(/mode/)
  })

  it('rejects an object with an unexpected key (e.g. bright_orange)', () => {
    expect(() => renderColorsToml({ ...GOLDEN_PALETTE, bright_orange: '#ffaa00' })).toThrow(/unexpected key/)
  })
})
