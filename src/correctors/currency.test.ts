import { describe, it, expect } from 'vitest'
import { currency } from './currency.js'

describe('currency corrector', () => {
  it('normalizes "dollars" to USD', () => {
    const data = { currency: 'dollars' }
    const result = currency(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.currency).toBe('USD')
  })

  it('normalizes "euro" to EUR', () => {
    const data = { currency: 'euro' }
    const result = currency(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.currency).toBe('EUR')
  })

  it('leaves ISO 4217 codes untouched', () => {
    const data = { currency: 'USD' }
    const result = currency(data, {})
    expect(result.corrected).toBe(false)
  })

  it('warns on unknown currency', () => {
    const data = { currency: 'space_bucks' }
    const result = currency(data, {})
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true)
  })

  it('ignores non-currency fields', () => {
    const data = { name: 'dollars', count: 5 }
    const result = currency(data, {})
    expect(result.corrected).toBe(false)
  })

  it('handles nested objects', () => {
    const data = { payment: { currency: 'pounds' } }
    const result = currency(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.payment.currency).toBe('GBP')
  })
})
