/**
 * RED-248: execute_code dispatches through the exec substrate registry.
 *
 * - Missing execPolicy on ctx → hard error (no silent-native fallback).
 * - runtime: 'native' → real NativeSubstrate runs the code.
 * - runtime: 'wasm' → WasmSubstrate stub surfaces its "not yet
 *   implemented" reason via stderr + exit_code != 0.
 * - Normalizes 'node' to 'js' at the language boundary.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execute, _resetNativeWarningForTests } from './execute_code.tool.js';
import type { ToolContext } from '../tools/tool-context.js';
import type { ExecPolicy } from '../tools/permissions.js';

type Step = { type: string; ok?: boolean; meta?: any };

function ctxWithExec(exec: ExecPolicy, emittedSteps?: Step[]): ToolContext {
  return {
    toolName: 'execute_code',
    fetch: () => { throw new Error('not used in this test'); },
    execPolicy: exec,
    emitStep: emittedSteps ? (s) => emittedSteps.push(s) : undefined,
  };
}

beforeEach(() => _resetNativeWarningForTests());

describe('execute_code (RED-248 dispatch)', () => {
  it('refuses to run when no execPolicy is on ctx (no silent fig-leaf)', async () => {
    const ctxNoExec: ToolContext = {
      toolName: 'execute_code',
      fetch: () => { throw new Error('not used'); },
    };
    await expect(execute({ language: 'node', code: 'console.log("hi")' }, ctxNoExec))
      .rejects.toThrow(/no security exec policy available/);
  });

  it('runtime: "native" runs the code via NativeSubstrate', async () => {
    const ctx = ctxWithExec({
      allowed: true,
      runtime: 'native',
      timeout: 5,
    });
    const result = await execute({ language: 'node', code: 'console.log("hello native")' }, ctx);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('hello native');
  });

  it('runtime: "wasm" surfaces the stub\'s "not yet implemented" reason', async () => {
    const ctx = ctxWithExec({
      allowed: true,
      runtime: 'wasm',
      timeout: 5,
    });
    const result = await execute({ language: 'node', code: 'console.log("irrelevant")' }, ctx);
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toMatch(/WASM substrate not yet implemented/);
    // The collapsed status tag must be visible so the model knows *why*
    // the call failed — not just a bare nonzero exit.
    expect(result.stderr).toMatch(/\[crashed:/);
  });

  it('normalizes language "node" to "js" at the substrate boundary', async () => {
    // We exercise this via the native substrate: 'node' MUST run through.
    // The normalization is internal, not observable from the input
    // shape, but it's the compatibility bridge between today's input
    // schema (python|node) and the substrate interface (python|js).
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 });
    const result = await execute({ language: 'node', code: 'process.stdout.write("ok")' }, ctx);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('ok');
  });

  it('rejects an unsupported language with a clear message', async () => {
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 });
    await expect(execute({ language: 'ruby', code: 'puts "x"' }, ctx))
      .rejects.toThrow(/unsupported language "ruby"/);
  });

  it('applies defaults when execPolicy omits cpu/memory/timeout', async () => {
    // No explicit caps — substrate gets the tool\'s DEFAULTS.
    const ctx = ctxWithExec({ allowed: true, runtime: 'native' });
    const result = await execute({ language: 'node', code: 'console.log("defaults ok")' }, ctx);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('defaults ok');
  });

  // RED-248 security review Finding 4: allowed: false must refuse
  // regardless of whether a runtime is set.
  it('refuses when execPolicy.allowed is false (even if a runtime is set)', async () => {
    const ctx = ctxWithExec({
      allowed: false,           // explicit deny
      runtime: 'native',        // shouldn't matter
    });
    await expect(execute({ language: 'node', code: 'console.log("should not run")' }, ctx))
      .rejects.toThrow(/exec is not allowed by the gen security policy/);
  });

  it('refuses when allowed is false and no runtime is set', async () => {
    const ctx = ctxWithExec({ allowed: false });
    await expect(execute({ language: 'node', code: 'console.log("nope")' }, ctx))
      .rejects.toThrow(/exec is not allowed/);
  });
});

// RED-249: structured trace events on every dispatch.
describe('execute_code — trace events (RED-249)', () => {
  it('emits ExecSpawned + ExecCompleted on a successful run', async () => {
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, steps);
    await execute({ language: 'node', code: 'console.log("hi")' }, ctx);

    const spawned = steps.find(s => s.type === 'ExecSpawned');
    expect(spawned).toBeDefined();
    expect(spawned!.meta).toMatchObject({
      runtime: 'native',
      language: 'js',
      timeout: 5,
    });

    const completed = steps.find(s => s.type === 'ExecCompleted');
    expect(completed).toBeDefined();
    expect(completed!.ok).toBe(true);
    expect(completed!.meta.exit_code).toBe(0);
    expect(completed!.meta.stdout_bytes).toBeGreaterThan(0);
    expect(completed!.meta.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits ExecTimeout when wall-clock cap hits', async () => {
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 1 }, steps);
    await execute({ language: 'node', code: 'while(true){}' }, ctx);

    const timeout = steps.find(s => s.type === 'ExecTimeout');
    expect(timeout).toBeDefined();
    expect(timeout!.ok).toBe(false);
    expect(timeout!.meta.timeout_seconds).toBe(1);
    // No ExecCompleted when we hit the timeout branch.
    expect(steps.find(s => s.type === 'ExecCompleted')).toBeUndefined();
  });

  it('emits a non-ok ExecCompleted for nonzero-exit code (not ExecCrashed)', async () => {
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, steps);
    await execute({ language: 'node', code: 'process.exit(7);' }, ctx);

    const completed = steps.find(s => s.type === 'ExecCompleted');
    expect(completed).toBeDefined();
    expect(completed!.ok).toBe(false); // nonzero exit → ok: false
    expect(completed!.meta.exit_code).toBe(7);
    // Crashed is reserved for substrate-infra failures, not guest exit != 0.
    expect(steps.find(s => s.type === 'ExecCrashed')).toBeUndefined();
  });

  it('includes runtime in every emitted Exec* event meta', async () => {
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, steps);
    await execute({ language: 'node', code: 'console.log("x")' }, ctx);
    for (const s of steps.filter(s => s.type.startsWith('Exec'))) {
      expect(s.meta.runtime).toBe('native');
    }
  });
});

// RED-249: :native deprecation surface (trace event + stderr warning).
describe('execute_code — :native deprecation (RED-249)', () => {
  it('emits tool.exec.unsandboxed when runtime is :native', async () => {
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, steps);
    await execute({ language: 'node', code: 'console.log("hi")' }, ctx);

    const deprecation = steps.find(s => s.type === 'tool.exec.unsandboxed');
    expect(deprecation).toBeDefined();
    expect(deprecation!.meta).toMatchObject({
      tool: 'execute_code',
      deprecated: true,
    });
  });

  it('does NOT emit tool.exec.unsandboxed for non-native runtimes', async () => {
    // wasm substrate is a stub and returns crashed; the event should NOT
    // fire regardless.
    const steps: Step[] = [];
    const ctx = ctxWithExec({ allowed: true, runtime: 'wasm', timeout: 5 }, steps);
    await execute({ language: 'node', code: 'console.log("hi")' }, ctx);
    expect(steps.find(s => s.type === 'tool.exec.unsandboxed')).toBeUndefined();
  });

  it('writes the stderr deprecation warning on :native once per run (not per call)', async () => {
    // Two calls sharing the same emitStep closure = same run =
    // one stderr warning.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    const sharedSteps: Step[] = [];
    const ctxRunOne = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, sharedSteps);
    try {
      await execute({ language: 'node', code: 'console.log("a")' }, ctxRunOne);
      await execute({ language: 'node', code: 'console.log("b")' }, ctxRunOne);
    } finally {
      (process.stderr as any).write = originalWrite;
    }
    const warnings = captured.filter(c => c.includes('WARNING: execute_code uses exec runtime :native'));
    expect(warnings.length).toBe(1);
  });

  it('writes a fresh stderr warning for each distinct run (WeakMap dedup scoped per emitStep identity)', async () => {
    // Two runs = two distinct emitStep closures = two warnings.
    // This is the engine-mode / long-lived-host case that pre-RED-249
    // (pid-based dedup) got wrong.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      const ctxRunOne = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, []);
      await execute({ language: 'node', code: 'console.log("a")' }, ctxRunOne);
      const ctxRunTwo = ctxWithExec({ allowed: true, runtime: 'native', timeout: 5 }, []);
      await execute({ language: 'node', code: 'console.log("b")' }, ctxRunTwo);
    } finally {
      (process.stderr as any).write = originalWrite;
    }
    const warnings = captured.filter(c => c.includes('WARNING: execute_code uses exec runtime :native'));
    expect(warnings.length).toBe(2);
  });
});
