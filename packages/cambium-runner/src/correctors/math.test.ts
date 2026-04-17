import { describe, it, expect } from 'vitest'
import { math } from './math.js'

describe('math corrector', () => {
  it('recomputes avg when mismatched', () => {
    const data = {
      metrics: {
        latency_ms_samples: [120, 140, 160],
        avg_latency_ms: 999,
      },
    }

    const result = math(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.metrics.avg_latency_ms).toBe(140)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('fixed')
  })

  it('does nothing when avg is correct', () => {
    const data = {
      metrics: {
        latency_ms_samples: [120, 140, 160],
        avg_latency_ms: 140,
      },
    }

    const result = math(data, {})
    expect(result.corrected).toBe(false)
    expect(result.issues).toHaveLength(0)
  })

  it('does nothing when no samples field exists', () => {
    const data = { summary: 'hello', metrics: { count: 5 } }
    const result = math(data, {})
    expect(result.corrected).toBe(false)
  })

  it('handles nested objects', () => {
    const data = {
      outer: {
        latency_ms_samples: [10, 20, 30],
        avg_latency_ms: 0,
      },
    }

    const result = math(data, {})
    expect(result.corrected).toBe(true)
    expect(result.output.outer.avg_latency_ms).toBe(20)
  })

  it('does not mutate original data', () => {
    const data = {
      metrics: {
        latency_ms_samples: [100, 200],
        avg_latency_ms: 999,
      },
    }
    const original = JSON.parse(JSON.stringify(data))
    math(data, {})
    expect(data).toEqual(original)
  })
})
