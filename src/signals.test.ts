import { describe, it, expect } from 'vitest'
import { extractSignals } from './signals.js'

describe('extractSignals', () => {
  it('extracts by explicit path', () => {
    const data = { metrics: { latency_ms_samples: [120, 140, 160] } }
    const signals = [{ name: 'latency_ms', type: 'number', path: 'metrics.latency_ms_samples' }]

    const state = extractSignals(data, signals)
    expect(state.latency_ms).toEqual([120, 140, 160])
  })

  it('auto-discovers by field name', () => {
    const data = { latency_ms: 150 }
    const signals = [{ name: 'latency_ms', type: 'number' }]

    const state = extractSignals(data, signals)
    expect(state.latency_ms).toBe(150)
  })

  it('auto-discovers in nested objects', () => {
    const data = { metrics: { latency_ms: [100, 200] } }
    const signals = [{ name: 'latency_ms', type: 'number' }]

    const state = extractSignals(data, signals)
    expect(state.latency_ms).toEqual([100, 200])
  })

  it('returns empty state for unmatched signals', () => {
    const data = { summary: 'hello' }
    const signals = [{ name: 'missing_field', type: 'number' }]

    const state = extractSignals(data, signals)
    expect(state).toEqual({})
  })

  it('handles multiple signals', () => {
    const data = {
      metrics: { latency_ms_samples: [120, 140] },
      risk_score: 0.8,
    }
    const signals = [
      { name: 'latency_ms', type: 'number', path: 'metrics.latency_ms_samples' },
      { name: 'risk_score', type: 'number' },
    ]

    const state = extractSignals(data, signals)
    expect(state.latency_ms).toEqual([120, 140])
    expect(state.risk_score).toBe(0.8)
  })

  it('handles empty signal definitions', () => {
    const state = extractSignals({ a: 1 }, [])
    expect(state).toEqual({})
  })
})
