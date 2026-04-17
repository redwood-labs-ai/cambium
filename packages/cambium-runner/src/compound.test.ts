import { describe, it, expect } from 'vitest'
import { runConsensus } from './compound.js'

describe('runConsensus', () => {
  it('agrees when outputs are identical', () => {
    const outputs = [
      { summary: 'same', metrics: { values: [1, 2, 3] } },
      { summary: 'same', metrics: { values: [1, 2, 3] } },
    ]

    const result = runConsensus(outputs)
    expect(result.ok).toBe(true)
    expect(result.disagreements).toHaveLength(0)
  })

  it('detects disagreements in primitive fields', () => {
    const outputs = [
      { summary: 'version A' },
      { summary: 'version B' },
    ]

    const result = runConsensus(outputs)
    expect(result.ok).toBe(false)
    expect(result.disagreements).toHaveLength(1)
    expect(result.disagreements[0].path).toBe('summary')
  })

  it('detects array length disagreements', () => {
    const outputs = [
      { values: [1, 2] },
      { values: [1, 2, 3, 4] },
    ]

    const result = runConsensus(outputs)
    expect(result.ok).toBe(false)
    expect(result.disagreements[0].path).toBe('values')
    expect(result.disagreements[0].message).toContain('Array lengths differ')
  })

  it('takes the longest array as consensus', () => {
    const outputs = [
      { values: [1, 2] },
      { values: [1, 2, 3, 4] },
    ]

    const result = runConsensus(outputs)
    expect(result.agreed.values).toEqual([1, 2, 3, 4])
  })

  it('handles single output', () => {
    const result = runConsensus([{ x: 1 }])
    expect(result.ok).toBe(true)
    expect(result.agreed).toEqual({ x: 1 })
  })

  it('detects nested disagreements', () => {
    const outputs = [
      { metrics: { count: 5 } },
      { metrics: { count: 10 } },
    ]

    const result = runConsensus(outputs)
    expect(result.ok).toBe(false)
    expect(result.disagreements[0].path).toBe('metrics.count')
  })
})
