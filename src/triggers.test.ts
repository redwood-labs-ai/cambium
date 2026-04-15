import { describe, it, expect } from 'vitest'
import { evaluateTriggers } from './triggers.js'
import { ToolRegistry } from './tools/registry.js'
import { join } from 'node:path'

async function loadedRegistry() {
  const reg = new ToolRegistry()
  await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
  return reg
}

describe('evaluateTriggers', () => {
  it('fires a tool call when signal has values', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
      target: 'metrics.avg_latency_ms',
    }]
    const state = { latency_ms: [120, 140, 160] }

    const results = await evaluateTriggers(triggers, state, await loadedRegistry(), ['calculator'])
    expect(results).toHaveLength(1)
    expect(results[0].fired).toBe(true)
    expect(results[0].value).toBe(140)
    expect(results[0].target).toBe('metrics.avg_latency_ms')
  })

  it('skips when signal is not present', async () => {
    const triggers = [{
      on: 'missing_signal',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]

    const results = await evaluateTriggers(triggers, {}, await loadedRegistry(), ['calculator'])
    expect(results[0].fired).toBe(false)
  })

  it('skips when signal is empty array', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]
    const state = { latency_ms: [] }

    const results = await evaluateTriggers(triggers, state, await loadedRegistry(), ['calculator'])
    expect(results[0].fired).toBe(false)
  })

  it('rejects when tool not in allowlist', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'tool_call',
      tool: 'calculator',
      args: { operation: 'avg' },
    }]
    const state = { latency_ms: [100] }

    await expect(
      evaluateTriggers(triggers, state, await loadedRegistry(), [])
    ).rejects.toThrow('not in policies.tools_allowed')
  })

  it('skips unknown action types', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'send_email',
      tool: 'mailer',
      args: {},
    }]
    const state = { latency_ms: [100] }

    const results = await evaluateTriggers(triggers, state, await loadedRegistry(), [])
    expect(results[0].fired).toBe(false)
  })
})
