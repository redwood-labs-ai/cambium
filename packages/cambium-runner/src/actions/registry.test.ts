import { describe, it, expect } from 'vitest';
import { ActionRegistry } from './registry.js';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('ActionRegistry (RED-212)', () => {
  it('loads builtin actions from src/builtin-actions/', async () => {
    const reg = new ActionRegistry();
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium-runner/src/builtin-actions'));
    expect(reg.list()).toContain('notify_stderr');
    const def = reg.get('notify_stderr');
    expect(def?.permissions?.pure).toBe(true);
    expect(typeof reg.getHandler('notify_stderr')).toBe('function');
  });

  it('returns undefined for unknown action names', async () => {
    const reg = new ActionRegistry();
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium-runner/src/builtin-actions'));
    expect(reg.get('not_an_action')).toBeUndefined();
    expect(reg.getHandler('not_an_action')).toBeUndefined();
  });

  it('is a no-op when the directory does not exist', async () => {
    const reg = new ActionRegistry();
    await reg.loadFromDir(join(tmpdir(), 'cambium-not-a-real-dir-' + Math.random()));
    expect(reg.list()).toEqual([]);
  });

  it('errors on a .action.json with no sibling handler file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-action-missing-'));
    writeFileSync(join(dir, 'orphan.action.json'), JSON.stringify({
      name: 'orphan',
      description: 'no handler',
      inputSchema: { type: 'object' },
    }));
    const reg = new ActionRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/no sibling .action.ts/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('errors on a handler file that does not export execute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-action-bad-'));
    writeFileSync(join(dir, 'bad.action.json'), JSON.stringify({
      name: 'bad',
      description: 'no execute export',
      inputSchema: { type: 'object' },
    }));
    writeFileSync(join(dir, 'bad.action.ts'), `export const notExecute = () => {}\n`);
    const reg = new ActionRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/must export an 'execute' function/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('errors on a schema file missing required fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-action-invalid-'));
    writeFileSync(join(dir, 'incomplete.action.json'), JSON.stringify({
      description: 'missing name + inputSchema',
    }));
    const reg = new ActionRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/missing name or inputSchema/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('notify_stderr action (RED-212 reference)', () => {
  it('writes to stderr and returns { value: "<line>" }', async () => {
    const reg = new ActionRegistry();
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium-runner/src/builtin-actions'));
    const handler = reg.getHandler('notify_stderr')!;

    // Capture stderr for the assertion.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      const out = await handler({ message: 'hello from test', prefix: '[TEST]' });
      expect(out).toEqual({ value: '[TEST] hello from test' });
      expect(captured.join('')).toContain('[TEST] hello from test');
    } finally {
      (process.stderr as any).write = originalWrite;
    }
  });

  it('falls back to stringified input when message is absent', async () => {
    const reg = new ActionRegistry();
    await reg.loadFromDir(join(process.cwd(), 'packages/cambium-runner/src/builtin-actions'));
    const handler = reg.getHandler('notify_stderr')!;

    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      const out = await handler({ operands: [100, 200, 300] });
      expect(out.value).toContain('operands=[100,200,300]');
      expect(captured.join('')).toContain('operands=[100,200,300]');
    } finally {
      (process.stderr as any).write = originalWrite;
    }
  });
});
