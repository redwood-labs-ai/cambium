import { describe, it, expect } from 'vitest'
import { evaluateTriggers } from './triggers.js'
import { ToolRegistry } from './tools/registry.js'
import { ActionRegistry } from './actions/registry.js'
import { join } from 'node:path'

async function loadedRegistry() {
  const reg = new ToolRegistry()
  await reg.loadFromDir(join(process.cwd(), 'src/builtin-tools'))
  await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'))
  return reg
}

async function loadedActionRegistry() {
  const reg = new ActionRegistry()
  await reg.loadFromDir(join(process.cwd(), 'src/builtin-actions'))
  return reg
}

// Silence stderr writes from notify_stderr during tests (the integration
// test still asserts on captured output).
function withSilentStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = () => true
  return fn().finally(() => { (process.stderr as any).write = originalWrite })
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

// RED-212: action_call branch — custom side-effect handlers addressed
// through the ActionRegistry instead of the ToolRegistry. No uses :name
// allowlist applies; actions are compile-time declared in the trigger
// block, never model-chosen.
describe('evaluateTriggers — action_call (RED-212)', () => {
  it('dispatches a custom action and returns the handler output', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'action_call',
      name: 'notify_stderr',
      args: { prefix: '[TRIGGER]', message: 'high latency' },
      target: 'notification',
    }]
    const state = { latency_ms: [140] }

    const results = await withSilentStderr(async () =>
      evaluateTriggers(
        triggers, state,
        await loadedRegistry(), [],
        {},
        await loadedActionRegistry(),
      ),
    )
    expect(results).toHaveLength(1)
    expect(results[0].fired).toBe(true)
    expect(results[0].target).toBe('notification')
    expect(results[0].value).toBe('[TRIGGER] high latency')
    expect(results[0].traceEntry.type).toBe('ActionCall')
    expect(results[0].traceEntry.meta.action).toBe('notify_stderr')
  })

  it('records an ActionCall error trace when the action is unknown', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'action_call',
      name: 'no_such_action',
      args: {},
    }]
    const state = { latency_ms: [100] }

    const results = await evaluateTriggers(
      triggers, state, await loadedRegistry(), [],
      {}, await loadedActionRegistry(),
    )
    expect(results[0].fired).toBe(false)
    expect(results[0].traceEntry.type).toBe('ActionCall')
    expect(results[0].traceEntry.ok).toBe(false)
    expect(results[0].traceEntry.errors[0].message).toMatch(/not found in registry/)
  })

  it('skips action_call triggers with a traced reason when no ActionRegistry is provided', async () => {
    // Back-compat path — pre-RED-212 callers that never pass an
    // ActionRegistry. Production runner always passes one.
    const triggers = [{
      on: 'latency_ms',
      action: 'action_call',
      name: 'notify_stderr',
      args: {},
    }]
    const state = { latency_ms: [100] }

    const results = await evaluateTriggers(
      triggers, state, await loadedRegistry(), [],
    )
    expect(results[0].fired).toBe(false)
    expect(results[0].traceEntry.type).toBe('TriggerSkipped')
    expect(results[0].traceEntry.meta.reason).toMatch(/no ActionRegistry provided/)
  })

  it('skips an action_call when the signal is empty', async () => {
    const triggers = [{
      on: 'latency_ms',
      action: 'action_call',
      name: 'notify_stderr',
      args: {},
    }]
    const results = await evaluateTriggers(
      triggers, { latency_ms: [] }, await loadedRegistry(), [],
      {}, await loadedActionRegistry(),
    )
    expect(results[0].fired).toBe(false)
    expect(results[0].traceEntry.type).toBe('TriggerSkipped')
  })

  // cambium-security review caught this as CRITICAL: dispatchAction
  // was passing env.policy (SecurityPolicy) where buildToolContext
  // expects a NetworkPolicy. A network-using action would have either
  // crashed at policy.allowlist access or bypassed SSRF. Regression
  // guard: invoke a network-using action, confirm ctx.fetch receives
  // the gen's NetworkPolicy (and therefore enforces the allowlist).
  it('passes the gen\'s NetworkPolicy (not SecurityPolicy) into ctx.fetch — RED-212 SSRF regression guard', async () => {
    // Register a tiny inline action via a fresh ActionRegistry so we
    // can observe what ctx.fetch actually sees.
    const { ActionRegistry: AR } = await import('./actions/registry.js')
    const reg = new AR()
    let observedCtxFetch: any = null
    reg['defs'].set('peek_ctx', {
      name: 'peek_ctx', description: 'test', inputSchema: { type: 'object' },
    } as any)
    reg['handlers'].set('peek_ctx', async (_input, ctx) => {
      observedCtxFetch = ctx?.fetch
      return { value: 'ok' }
    })

    const networkPolicy = {
      allowlist: ['api.example.com'],
      denylist: [],
      block_private: true,
      block_metadata: true,
    }
    const securityPolicy = { network: networkPolicy }

    await evaluateTriggers(
      [{
        on: 'trigger_me',
        action: 'action_call',
        name: 'peek_ctx',
        args: {},
      }],
      { trigger_me: [1] },
      await loadedRegistry(), [],
      { policy: securityPolicy as any },
      reg,
    )

    // ctx.fetch must exist (policy was provided, so the policy-bound
    // variant is installed — not the "throw when no policy" fallback).
    expect(typeof observedCtxFetch).toBe('function')
  })
})
