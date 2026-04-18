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

  it('passes silently when wasm is available (quickjs-emscripten installed)', () => {
    // Precondition: the monorepo has `quickjs-emscripten` in
    // optionalDependencies. If someone runs tests without it installed
    // this test will flip, at which point the substrate's fallback
    // reason becomes the assertion.
    expect(() => checkRuntime('wasm')).not.toThrow();
  });

  it('throws with the substrate reason when firecracker is not available on this host', () => {
    // On Linux hosts WITH KVM + firecracker + env vars configured this
    // would pass. Our dev/CI hosts aren't that; expect a platform or
    // environment-gated rejection that surfaces the substrate's reason
    // string, not a generic "unknown substrate."
    if (process.platform === 'linux') return;
    expect(() => checkRuntime('firecracker')).toThrow(/requires Linux \+ KVM/);
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

describe('WasmSubstrate (real — quickjs-emscripten)', () => {
  const sub = new WasmSubstrate();

  it('reports available when quickjs-emscripten is installed', () => {
    expect(sub.available()).toBeNull();
  });

  it('runs a trivial JS program and returns completed', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'console.log("hello from wasm");',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from wasm');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a runtime error (ReferenceError etc.) as completed with exit_code !== 0', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'nosuchfunction();',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/nosuchfunction|ReferenceError|not defined/);
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

  it('surfaces memory exhaustion as status: "oom"', async () => {
    const result = await sub.execute({
      language: 'js',
      // Progressive allocation. A very small memory cap (16 MB) is
      // the minimum QuickJS accepts; fill it with a giant array.
      code: 'const a = []; while(true) a.push(new Array(100000).fill("x"));',
      cpu: 1,
      memory: 16,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('oom');
    expect(result.reason).toMatch(/memory/i);
  });

  it('rejects python with a pointer to :firecracker / future Pyodide', async () => {
    const result = await sub.execute({
      language: 'python',
      code: 'print("hi")',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/Python is not supported/);
    expect(result.reason).toMatch(/firecracker|Pyodide/i);
  });

  it('has no filesystem capability — guest code cannot read a real host path', async () => {
    // QuickJS doesn't expose Node's `fs`; attempting to require it
    // fails at the "require is not defined" layer. No preopens either.
    const result = await sub.execute({
      language: 'js',
      code: 'const fs = require("fs"); console.log(fs.readFileSync("/etc/passwd"));',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/require|not defined/);
  });

  it('has no network capability — guest code cannot fetch', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'fetch("http://169.254.169.254/latest/meta-data/").then(r => console.log(r.status));',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    // fetch is not a global in QuickJS — reference error or "is not a function".
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/fetch|not defined|not a function/);
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

  it('evaluates arithmetic and returns the expected captured output', async () => {
    const result = await sub.execute({
      language: 'js',
      code: 'const n = [1,2,3,4,5].reduce((a,b)=>a+b,0); console.log(n);',
      cpu: 1,
      memory: 64,
      timeout: 5,
      network: 'none',
      filesystem: 'none',
      maxOutputBytes: 50_000,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('15');
  });
});

describe('FirecrackerSubstrate', () => {
  const sub = new FirecrackerSubstrate();

  it('reports unavailable on non-Linux hosts with a platform-specific reason', () => {
    if (process.platform === 'linux') return;
    const reason = sub.available();
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/requires Linux \+ KVM/);
    expect(reason).toMatch(process.platform);
  });

  // Deeper per-gate tests live in firecracker.test.ts (env-var gating,
  // KVM accessibility, etc.); this block just confirms the registry
  // returns a FirecrackerSubstrate and its availability probe never
  // throws (the ExecSubstrate interface contract).
  it('available() never throws, regardless of host state', () => {
    expect(() => sub.available()).not.toThrow();
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
