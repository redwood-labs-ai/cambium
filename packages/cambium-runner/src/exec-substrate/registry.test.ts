/**
 * RED-247: registry + substrate-dispatch sanity tests.
 *
 * Exercises the three default substrates at the framework level:
 *   - native works end-to-end (it's the only non-stub in this PR)
 *   - wasm + firecracker are stubs that report unavailable
 *   - the registry gives back the right instance per name
 *   - checkRuntime throws with the substrate's reason when unavailable
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getSubstrate,
  getSubstrateRegistry,
  checkRuntime,
  _resetRegistryForTests,
} from './registry.js';
import { NativeSubstrate } from './native.js';
import { WasmSubstrate } from './wasm.js';
import { FirecrackerSubstrate } from './firecracker.js';

afterEach(() => _resetRegistryForTests());

describe('substrate registry', () => {
  it('returns the three default substrates by name', () => {
    const reg = getSubstrateRegistry();
    expect(reg.native).toBeInstanceOf(NativeSubstrate);
    expect(reg.wasm).toBeInstanceOf(WasmSubstrate);
    expect(reg.firecracker).toBeInstanceOf(FirecrackerSubstrate);
  });

  it('getSubstrate is idempotent across calls', () => {
    const a = getSubstrate('native');
    const b = getSubstrate('native');
    expect(a).toBe(b);
  });
});

describe('checkRuntime', () => {
  it('passes silently when the substrate reports available', () => {
    expect(() => checkRuntime('native')).not.toThrow();
  });

  it('throws with the substrate reason when wasm is not yet implemented', () => {
    expect(() => checkRuntime('wasm')).toThrow(/WASM substrate not yet implemented/);
  });

  it('throws with the substrate reason when firecracker is not yet implemented', () => {
    expect(() => checkRuntime('firecracker')).toThrow(/Firecracker substrate not yet implemented/);
  });
});

describe('NativeSubstrate', () => {
  const sub = new NativeSubstrate();

  it('reports available', () => {
    expect(sub.available()).toBeNull();
  });

  it('runs a trivial js program and returns completed', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'console.log("hello");',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a nonzero exit as completed with exit_code != 0 (not crashed)', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'process.exit(7);',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(7);
  });

  it('surfaces wall-clock timeout as status: "timeout"', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'while(true){}', // infinite loop
      cpu: 1,
      memory: 64,
      timeout: 1,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('timeout');
    expect(result.reason).toMatch(/timeout/);
  });

  it('rejects unsupported languages with status: "crashed"', async () => {
    const result = await sub.execute({
      language: 'ruby' as any,
      code: 'puts "hi"',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/does not support language "ruby"/);
  });

  it('truncates stdout past maxOutputBytes with a marker', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'for(let i=0;i<10000;i++) console.log("xxxxxxxxxxxxxxxxxxxx");',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 1_000,
    });
    expect(result.status).toBe('completed');
    expect(result.truncated.stdout).toBe(true);
    expect(result.stdout).toContain('[truncated at 1000 bytes]');
  });
});

describe('WasmSubstrate (stub)', () => {
  const sub = new WasmSubstrate();

  it('reports unavailable with a pointer to back-compat substrates', () => {
    const reason = sub.available();
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/not yet implemented/);
    expect(reason).toMatch(/runtime: :native|runtime: :firecracker/);
  });

  it('execute returns crashed with a clear reason', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'anything',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/WASM substrate not yet implemented/);
  });
});

describe('FirecrackerSubstrate (stub)', () => {
  const sub = new FirecrackerSubstrate();

  it('reports unavailable with a pointer to back-compat substrates', () => {
    const reason = sub.available();
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/not yet implemented/);
  });
});

// RED-248 security review Finding 2: proto-safety.
describe('getSubstrate — proto-safety', () => {
  it('rejects "__proto__" with a clear "Unknown substrate" error', () => {
    expect(() => getSubstrate('__proto__' as any)).toThrow(/Unknown exec substrate: "__proto__"/);
  });

  it('rejects "toString" (a method on Object.prototype) the same way', () => {
    expect(() => getSubstrate('toString' as any)).toThrow(/Unknown exec substrate: "toString"/);
  });

  it('rejects "constructor"', () => {
    expect(() => getSubstrate('constructor' as any)).toThrow(/Unknown exec substrate/);
  });

  it('rejects an arbitrary string', () => {
    expect(() => getSubstrate('gvisor' as any)).toThrow(/Unknown exec substrate: "gvisor"/);
  });
});
