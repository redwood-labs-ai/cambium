import { describe, it, expect } from 'vitest'
import { evaluateTriggers } from './triggers.js'
import { ToolRegistry } from './tools/registry.js'
import { join } from 'node:path'

function loadedRegistry() {
  const reg = new ToolRegistry()
  reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
  return reg
}

describe('evaluateTriggers', () => {
  it('fires a tool call when signal has values', () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
      target: 'metrics.avg_latency_ms',
    }]
    const state = { latency_ms: [120, 140, 160] }

    const results = evaluateTriggers(triggers, state, loadedRegistry(), ['calculator'])
    expect(results).toHaveLength(1)
    expect(results[0].fired).toBe(true)
    expect(results[0].value).toBe(140)
    expect(results[0].target).toBe('metrics.avg_latency_ms')
  })

  it('skips when signal is not present', () => {
    const triggers = [{
      on: 'missing_signal',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]

    const results = evaluateTriggers(triggers, {}, loadedRegistry(), ['calculator'])
    expect(results[0].fired).toBe(false)
  })

  it('skips when signal is empty array', () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]
    const state = { latency_ms: [] }

    const results = evaluateTriggers(triggers, state, loadedRegistry(), ['calculator'])
    expect(results[0].fired).toBe(false)
  })

  it('throws when tool not in allowlist', () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]
    const state = { latency_ms: [100] }

    expect(() =>
      evaluateTriggers(triggers, state, loadedRegistry(), [])
    ).toThrow('not in policies.tools_allowed')
  })

  it('skips unknown action types', () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'send_email',
      tool: 'mailer',
      args: {},
    }]
    const state = { latency_ms: [100] }

    const results = evaluateTriggers(triggers, state, loadedRegistry(), [])
    expect(results[0].fired).toBe(false)
  })
})
