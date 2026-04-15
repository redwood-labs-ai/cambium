/**
 * Tests that handleToolCall's env hooks — budget pre-call gate and
 * permission-denied trace events — do the right thing at the dispatch site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { handleToolCall } from '../step-handlers.js';
import { ToolRegistry } from './registry.js';
import { builtinTools } from './index.js';
import { Budget } from '../budget.js';
import type { SecurityPolicy } from './permissions.js';

// Calculator is pure — no network, no filesystem. Good probe tool for
// testing the dispatch envelope without triggering real side effects.
const registry = new ToolRegistry();
const registerDef = (def: any) => (registry as any).defs.set(def.name, def);
registerDef({
  name: 'calculator',
  description: 'arithmetic',
  permissions: { pure: true },
  inputSchema: {},
  outputSchema: {},
});

const allowlist = ['calculator'];

describe('handleToolCall env — budget gate', () => {
  it('refuses the call that would exceed max_calls (per-tool)', async () => {
    const budget = new Budget({}, { calculator: { max_calls: 2 } });
    const trace: any[] = [];

    await handleToolCall('calculator', 'sum', { operation: 'sum', operands: [1, 2] }, registry, allowlist, { budget, traceEvents: trace });
    await handleToolCall('calculator', 'sum', { operation: 'sum', operands: [3, 4] }, registry, allowlist, { budget, traceEvents: trace });

    await expect(
      handleToolCall('calculator', 'sum', { operation: 'sum', operands: [5, 6] }, registry, allowlist, { budget, traceEvents: trace }),
    ).rejects.toThrow(/Per-tool call budget exceeded/);

    const exceeded = trace.find(e => e.type === 'tool.budget.exceeded');
    expect(exceeded).toBeDefined();
    expect(exceeded.tool).toBe('calculator');
    expect(exceeded.metric).toBe('max_calls');
    expect(exceeded.limit).toBe(2);
  });

  it('allows calls within limits and records them in the budget', async () => {
    const budget = new Budget({}, { calculator: { max_calls: 5 } });
    await handleToolCall('calculator', 'sum', { operation: 'sum', operands: [1, 2] }, registry, allowlist, { budget });
    await handleToolCall('calculator', 'sum', { operation: 'sum', operands: [3, 4] }, registry, allowlist, { budget });
    expect(budget.getToolUsage('calculator').calls).toBe(2);
  });

  it('refuses when per-run max_tool_calls is hit, even if per-tool has room', async () => {
    const budget = new Budget({ max_tool_calls: 1 }, { calculator: { max_calls: 99 } });
    await handleToolCall('calculator', 'sum', { operation: 'sum', operands: [1, 2] }, registry, allowlist, { budget });
    await expect(
      handleToolCall('calculator', 'sum', { operation: 'sum', operands: [3, 4] }, registry, allowlist, { budget }),
    ).rejects.toThrow(/Per-run tool call budget exceeded/);
  });
});

describe('handleToolCall env — permission denied via ctx.fetch', () => {
  beforeEach(() => {
    // Register a shim "net_tool" that always tries to hit a URL via ctx.fetch.
    registerDef({
      name: 'net_tool',
      description: 'tries to fetch something',
      permissions: { network: true, network_hosts: ['api.example.com'] },
      inputSchema: {},
      outputSchema: {},
    });
    builtinTools['net_tool'] = async (_input: any, ctx: any) => {
      const res = await ctx.fetch('http://169.254.169.254/latest/meta-data/');
      return { ok: res.ok };
    };
  });

  it('emits tool.permission.denied when ctx.fetch is blocked', async () => {
    const policy: SecurityPolicy = {
      network: { allowlist: ['*'], denylist: [], block_private: true, block_metadata: true },
    };
    const trace: any[] = [];
    await expect(
      handleToolCall('net_tool', 'run', {}, registry, ['net_tool'], { policy, traceEvents: trace }),
    ).rejects.toThrow(/Network egress denied/);

    const denied = trace.find(e => e.type === 'tool.permission.denied');
    expect(denied).toBeDefined();
    expect(denied.tool).toBe('net_tool');
    expect(denied.host).toBe('169.254.169.254');
    expect(['block_private', 'block_metadata']).toContain(denied.reason);
  });

  it('denies immediately when gen has no network policy at all', async () => {
    const trace: any[] = [];
    await expect(
      handleToolCall('net_tool', 'run', {}, registry, ['net_tool'], { traceEvents: trace }),
    ).rejects.toThrow(/Network egress denied.*net_tool.*no network policy/);
  });
});

describe('handleToolCall — plugin tool dispatch (RED-209)', () => {
  it('dispatches a plugin tool whose handler was auto-discovered', async () => {
    // Use a fresh registry loaded from the real app/tools dir so we
    // exercise the full discovery path (not the shim registerDef above).
    const reg = new ToolRegistry();
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'));

    const result = await handleToolCall(
      'echo_plugin', 'run', { message: 'hello from plugin' }, reg, ['echo_plugin'],
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echoed: 'hello from plugin' });
  });

  it('prefers plugin handler over a builtin with the same name', async () => {
    // Register a builtin-map entry for `echo_plugin` that would produce
    // a different output; prove the plugin handler wins.
    builtinTools['echo_plugin'] = async () => ({ echoed: 'from-builtin' });
    try {
      const reg = new ToolRegistry();
      await reg.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'));
      const result = await handleToolCall(
        'echo_plugin', 'run', { message: 'from-plugin' }, reg, ['echo_plugin'],
      );
      expect(result.output).toEqual({ echoed: 'from-plugin' });
    } finally {
      delete builtinTools['echo_plugin'];
    }
  });
});
