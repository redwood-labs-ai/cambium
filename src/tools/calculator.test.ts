import { describe, it, expect } from 'vitest'
import { execute } from './calculator.js'

describe('calculator', () => {
  it('computes avg', () => {
    expect(execute({ operation: 'avg', operands: [120, 140, 160] })).toEqual({ value: 140 })
  })

  it('computes avg with rounding', () => {
    expect(execute({ operation: 'avg', operands: [120, 140, 160, 195] })).toEqual({ value: 153.75 })
  })

  it('computes sum', () => {
    expect(execute({ operation: 'sum', operands: [10, 20, 30] })).toEqual({ value: 60 })
  })

  it('computes min', () => {
    expect(execute({ operation: 'min', operands: [8, 120, 271] })).toEqual({ value: 8 })
  })

  it('computes max', () => {
    expect(execute({ operation: 'max', operands: [8, 120, 271] })).toEqual({ value: 271 })
  })

  it('throws on empty operands', () => {
    expect(() => execute({ operation: 'avg', operands: [] })).toThrow('empty operands')
  })

  it('throws on unknown operation', () => {
    expect(() => execute({ operation: 'median', operands: [1, 2, 3] })).toThrow('unknown operation')
  })
})
