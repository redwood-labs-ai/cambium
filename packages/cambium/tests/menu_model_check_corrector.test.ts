/**
 * #201: unit tests for the `menu_model_check` app corrector — runs the
 * real vendored Omarchy parser (`app/correctors/vendor/omarchy/menu_model.cjs`,
 * pinned commit 7d58bb9a) against the proposed entry merged into the
 * current overlay.
 */
import { describe, it, expect } from 'vitest'
import { menu_model_check } from '../app/correctors/menu_model_check.corrector.js'

function doc(overlay: string, request = 'add a menu entry') {
  return { document: JSON.stringify({ request, overlay }) }
}

describe('menu_model_check corrector', () => {
  it('a clean proposal (action only) against an empty overlay parses with kind=action and raises nothing', () => {
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes' },
      doc(''),
    )
    expect(result.corrected).toBe(false)
    expect(result.issues).toEqual([])
  })

  it('a clean proposal (target only) parses with kind=link and raises nothing', () => {
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', target: 'obsidian://open?vault=notes' },
      doc(''),
    )
    expect(result.corrected).toBe(false)
    expect(result.issues).toEqual([])
  })

  it('merges alongside an existing overlay entry without disturbing it', () => {
    const overlay = JSON.stringify({ projects: { label: 'Projects', target: 'https://github.com/me/projects' } })
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes' },
      doc(overlay),
    )
    expect(result.issues).toEqual([])
  })

  it('flags a proposal that sets BOTH action and target as an error, naming the real inferred kind', () => {
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes', target: 'obsidian://open' },
      doc(''),
    )
    expect(result.corrected).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].path).toBe('action,target')
    // The message names kind="action" — computed by the REAL parser
    // (action wins the priority order), not asserted by the corrector.
    expect(result.issues[0].message).toMatch(/kind="action"/)
  })

  it('an entry with neither action nor target (a submenu container) raises nothing', () => {
    const result = menu_model_check({ id: 'tools', label: 'Tools' }, doc(''))
    expect(result.issues).toEqual([])
  })

  it('an overlay with an inline trailing comment fails to parse — error, not a silent drop (SPEC §5.8)', () => {
    // stripJsonc only strips WHOLE-LINE `//` comments; a trailing inline
    // comment survives stripping and breaks JSON.parse for the ENTIRE
    // overlay, not just the line it's on.
    const overlay = '{\n  "projects": { "label": "Projects" } // inline comment\n}\n'
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes' },
      doc(overlay),
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].path).toBe('overlay')
    expect(result.issues[0].message).toMatch(/failed to parse/)
  })

  it('a whole-line comment and a trailing comma in the overlay strip cleanly (no false positive)', () => {
    const overlay = '{\n  // a hand-added bookmark\n  "projects": { "label": "Projects", "target": "https://x" },\n}\n'
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes' },
      doc(overlay),
    )
    expect(result.issues).toEqual([])
  })

  it('a proposal with no id is an error before any merge is attempted', () => {
    const result = menu_model_check({ label: 'Notes (Obsidian)', action: 'obsidian ~/notes' }, doc(''))
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].path).toBe('id')
  })

  it('never mutates data — report-only, like contrast_floor (#200)', () => {
    const input = { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes', target: 'obsidian://open' }
    const result = menu_model_check(input, doc(''))
    expect(result.corrected).toBe(false)
    expect(result.output).toBe(input)
  })

  it('missing context.document (no overlay at all) still checks the proposal on its own', () => {
    const result = menu_model_check(
      { id: 'obsidian-notes', label: 'Notes (Obsidian)', action: 'obsidian ~/notes', target: 'obsidian://open' },
      {},
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].path).toBe('action,target')
  })
})
