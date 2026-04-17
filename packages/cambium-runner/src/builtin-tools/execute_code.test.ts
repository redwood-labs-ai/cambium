/**
 * RED-248: execute_code dispatches through the exec substrate registry.
 *
 * - Missing execPolicy on ctx → hard error (no silent-native fallback).
 * - runtime: 'native' → real NativeSubstrate runs the code.
 * - runtime: 'wasm' → WasmSubstrate stub surfaces its "not yet
 *   implemented" reason via stderr + exit_code != 0.
 * - Normalizes 'node' to 'js' at the language boundary.
 */
import { describe, it, expect } from 'vitest';
import { execute } from './execute_code.tool.js';
import type { ToolContext } from '../tools/tool-context.js';
import type { ExecPolicy } from '../tools/permissions.js';

function ctxWithExec(exec: ExecPolicy): ToolContext {
  return {
    toolName: 'execute_code',
    fetch: () => { throw new Error('not used in this test'); },
    execPolicy: exec,
  };
}

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
