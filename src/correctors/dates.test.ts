import { describe, it, expect } from 'vitest'
import { dates } from './dates.js'

describe('dates corrector', () => {
  it('reformats "Month Day, Year" to ISO-8601', () => {
    const data = { as_of_date: 'April 8, 2026' }
    const result = dates(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.as_of_date).toBe('2026-04-08')
  })

  it('reformats "Day Month Year" to ISO-8601', () => {
    const data = { created_date: '8 April 2026' }
    const result = dates(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.created_date).toBe('2026-04-08')
  })

  it('leaves ISO-8601 dates untouched', () => {
    const data = { as_of_date: '2026-04-08' }
    const result = dates(data, {})
    expect(result.corrected).toBe(false)
  })

  it('ignores non-date fields', () => {
    const data = { summary: 'April 8, 2026 was a good day', count: 5 }
    const result = dates(data, {})
    expect(result.corrected).toBe(false)
  })

  it('warns on unparseable date fields', () => {
    const data = { event_date: 'last tuesday' }
    const result = dates(data, {})
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true)
  })

  it('does not mutate original data', () => {
    const data = { as_of_date: 'April 8, 2026' }
    const original = JSON.parse(JSON.stringify(data))
    dates(data, {})
    expect(data).toEqual(original)
  })
})
