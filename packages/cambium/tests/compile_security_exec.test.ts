/**
 * RED-248 / Gate-3: compile-time validation of the `security exec:` DSL shape.
 *
 * Three shapes accepted after Gate 3:
 *   - Sandboxed: `{ runtime: :wasm | :firecracker, cpu:, memory:, timeout:,
 *     network:, filesystem:, max_output_bytes: }` — runtime: required.
 *   - Sharp-knife opt-in: `{ unsafe_native: true }` — explicit unsandboxed
 *     native; emits `tool.exec.unsandboxed` + stderr warning on every call.
 *
 * These shapes are now COMPILE ERRORS:
 *   - `{ allowed: true }` with no runtime (DEC-003)
 *   - `{ runtime: :native, ... }` (DEC-002)
 *
 * Range validation + unknown-key rejection happens at compile time so
 * authors get clear errors before the runner ever starts.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt';

function compile(genPath: string, method: string): any {
  const stdout = execSync(
    `ruby ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${FIXTURE_ARG}`,
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

function compileExpectError(genPath: string, method: string): string {
  try {
    execSync(
      `ruby ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${FIXTURE_ARG}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    throw new Error('Expected compile to fail, but it succeeded');
  } catch (e: any) {
    return String(e.stderr ?? '') + String(e.message ?? '');
  }
}

function writeGen(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-red248-'));
  const gen = join(dir, 'g.cmb.rb');
  writeFileSync(gen, body.trim());
  return gen;
}

describe('security exec: DSL (RED-248 / Gate-3)', () => {
  // ── Gate-3 compile errors ───────────────────────────────────────────

  it('{ allowed: true } with no runtime is now a compile error (Gate 3)', () => {
    const gen = writeGen(`
class LegacyExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { allowed: true }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/no longer defaults to unsandboxed native/);
    expect(stderr).toMatch(/unsafe_native: true/);
  });

  it('runtime: :native is a compile error (Gate 3, DEC-002)', () => {
    const gen = writeGen(`
class NativeRuntime < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :native, cpu: 1, memory: 64, timeout: 5 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/runtime: :native is no longer accepted/);
    expect(stderr).toMatch(/unsafe_native: true/);
  });

  it('unsafe_native: true compiles to { allowed: true, runtime: "native", unsafe_native: true }', () => {
    const gen = writeGen(`
class UnsafeNativeExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { unsafe_native: true }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const ir = compile(gen, 'go');
    expect(ir.policies.security.exec).toMatchObject({
      allowed: true,
      runtime: 'native',
      unsafe_native: true,
    });
  });

  // ── allowed: false path (unchanged) ────────────────────────────────

  it('legacy `{ allowed: false }` does NOT auto-resolve runtime', () => {
    const gen = writeGen(`
class DeniedExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { allowed: false }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const ir = compile(gen, 'go');
    expect(ir.policies.security.exec).toMatchObject({ allowed: false });
    expect(ir.policies.security.exec.runtime).toBeUndefined();
  });

  // ── New shape ──────────────────────────────────────────────────────

  it('new shape with runtime: :wasm emits the full resolved policy', () => {
    const gen = writeGen(`
class ModernExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: {
    runtime: :wasm,
    cpu: 0.5,
    memory: 128,
    timeout: 10,
    network: :none,
    filesystem: :none,
    max_output_bytes: 10_000,
  }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const ir = compile(gen, 'go');
    expect(ir.policies.security.exec).toMatchObject({
      runtime: 'wasm',
      cpu: 0.5,
      memory: 128,
      timeout: 10,
      network: 'none',
      filesystem: 'none',
      max_output_bytes: 10_000,
    });
  });

  it('accepts :inherit for network (resolution happens TS-side at parse)', () => {
    const gen = writeGen(`
class InheritingExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security network: { allowlist: %w[api.example.com] }
  security exec: { runtime: :wasm, network: :inherit }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const ir = compile(gen, 'go');
    // Ruby-side emits the literal 'inherit' string; TS-side resolves it.
    expect(ir.policies.security.exec.network).toBe('inherit');
  });

  it('accepts an explicit hash for network (substrate-specific allowlist)', () => {
    const gen = writeGen(`
class HashNetworkExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: {
    runtime: :firecracker,
    network: { allowlist: %w[internal.example.com] }
  }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const ir = compile(gen, 'go');
    expect(ir.policies.security.exec.network).toEqual({
      allowlist: ['internal.example.com'],
    });
  });

  // ── Validation ─────────────────────────────────────────────────────

  it('rejects unknown top-level exec keys with a clear message', () => {
    const gen = writeGen(`
class BadExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, badkey: true }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/unknown security exec keys:.*badkey/);
  });

  it('rejects unknown runtime symbols', () => {
    const gen = writeGen(`
class UnknownRuntime < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :gvisor }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec runtime: must be one of/);
  });

  it('rejects cpu outside 0.1..4.0 range', () => {
    const gen = writeGen(`
class OutOfRangeCpu < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, cpu: 8.0 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec cpu: must be a number in 0\.1\.\.4\.0/);
  });

  it('rejects memory outside 16..4096 MB range', () => {
    const gen = writeGen(`
class OutOfRangeMem < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, memory: 8 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec memory: must be an integer in 16\.\.4096/);
  });

  it('rejects timeout outside 1..600 seconds', () => {
    const gen = writeGen(`
class OutOfRangeTimeout < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, timeout: 9999 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec timeout: must be an integer in 1\.\.600/);
  });

  it('rejects fractional timeout (floor truncation loses user intent)', () => {
    const gen = writeGen(`
class FractionalTimeout < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, timeout: 30.9 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec timeout: must be an integer/);
  });

  it('rejects a non-hash/non-symbol value for network:', () => {
    const gen = writeGen(`
class BadNetwork < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, network: "nope" }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/security exec network: must be :inherit, :none, or a Hash/);
  });
});

// DEC-004: CAMBIUM_STRICT_EXEC=1 now means org-wide lockdown — rejects even unsafe_native: true.
// { allowed: true } and runtime: :native are already unconditional compile errors (Gate 3).
describe('security exec: CAMBIUM_STRICT_EXEC=1 (DEC-004)', () => {
  function compileExpectErrorStrict(genPath: string, method: string): string {
    try {
      execSync(
        `CAMBIUM_STRICT_EXEC=1 ruby ruby/cambium/compile.rb ${genPath} --method ${method} --arg ${FIXTURE_ARG}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      throw new Error('Expected compile to fail, but it succeeded');
    } catch (e: any) {
      return String(e.stderr ?? '') + String(e.message ?? '');
    }
  }

  it('rejects { allowed: true } under strict mode (still a compile error, same as non-strict)', () => {
    const gen = writeGen(`
class StrictNative < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { allowed: true }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectErrorStrict(gen, 'go');
    expect(stderr).toMatch(/no longer defaults to unsandboxed native/);
  });

  it('rejects runtime: :native under strict mode (still a compile error, same as non-strict)', () => {
    const gen = writeGen(`
class StrictExplicitNative < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :native, cpu: 1, memory: 64, timeout: 5 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectErrorStrict(gen, 'go');
    expect(stderr).toMatch(/runtime: :native is no longer accepted/);
  });

  it('CAMBIUM_STRICT_EXEC=1 rejects even unsafe_native: true (DEC-004)', () => {
    const gen = writeGen(`
class StrictUnsafeNative < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { unsafe_native: true }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stderr = compileExpectErrorStrict(gen, 'go');
    expect(stderr).toMatch(/CAMBIUM_STRICT_EXEC=1 is set/);
    expect(stderr).toMatch(/unsandboxed native exec is prohibited/);
  });

  it('still accepts runtime: :wasm under strict mode', () => {
    const gen = writeGen(`
class StrictWasm < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security exec: { runtime: :wasm, cpu: 0.5, memory: 128, timeout: 10 }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`);
    const stdout = execSync(
      `CAMBIUM_STRICT_EXEC=1 ruby ruby/cambium/compile.rb ${gen} --method go --arg ${FIXTURE_ARG}`,
      { encoding: 'utf8' },
    );
    const ir = JSON.parse(stdout);
    expect(ir.policies.security.exec.runtime).toBe('wasm');
  });
});

// Policy-pack support: exec can be bundled in a *.policy.rb, and the
// per-slot mixing rule (RED-214) prohibits a gen from also declaring
// exec when the pack contributes it.
describe('security exec: via policy packs (RED-248 + RED-214)', () => {
  function writeGenAndPack(packBody: string, genBody: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red248-pack-'));
    writeFileSync(join(dir, 'exec_defaults.policy.rb'), packBody.trim());
    const gen = join(dir, 'g.cmb.rb');
    writeFileSync(gen, genBody.trim());
    return gen;
  }

  it('pack can declare exec: with the new shape; gen pulls it by symbol', () => {
    const gen = writeGenAndPack(
      `exec runtime: :wasm, cpu: 0.5, memory: 128, timeout: 10`,
      `
class PackedExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :exec_defaults
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`,
    );
    const ir = compile(gen, 'go');
    expect(ir.policies.security.exec).toMatchObject({
      runtime: 'wasm',
      cpu: 0.5,
      memory: 128,
      timeout: 10,
    });
  });

  it('per-slot mixing rule: pack + gen both providing exec is a compile error', () => {
    const gen = writeGenAndPack(
      `exec runtime: :wasm`,
      `
class DoubleExec < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :exec_defaults
  security exec: { runtime: :firecracker }
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`,
    );
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/exec/i);
    // The per-slot mixing error from RED-214 names the slot.
  });
});
