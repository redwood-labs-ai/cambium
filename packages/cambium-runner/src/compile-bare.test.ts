/**
 * RED-360: integration test for `compile.rb` bare-mode (no --method →
 * emit `{method: ir}` map). The wider Ruby behavior is exercised
 * end-to-end by the existing `cambium run` test surface; this test
 * focuses on the bare-mode shape that `cambium serve` boot consumes.
 *
 * Spawns the actual Ruby compile.rb against a tmp-dir fixture .cmb.rb,
 * so it requires `ruby` on PATH like the rest of the in-tree test suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cambium-runner/src/compile-bare.test.ts → workspace root.
const COMPILE_RB = resolve(__dirname, '../../..', 'ruby/cambium/compile.rb');

const MULTI_METHOD_FIXTURE = `
class MultiMethodGen < GenModel
  model "ollama:test"
  system "test prompt"

  def alpha(input)
    generate "alpha"
  end

  def beta(input)
    generate "beta"
  end
end
`;

const SINGLE_METHOD_FIXTURE = `
class SingleMethodGen < GenModel
  model "ollama:test"
  system "test prompt"

  def analyze(input)
    generate "single"
  end
end
`;

const NO_METHOD_FIXTURE = `
class NoMethodGen < GenModel
  model "ollama:test"
  system "test prompt"
end
`;

describe('compile.rb bare mode (RED-360)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-compile-bare-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixture(name: string, contents: string): string {
    const path = join(tmp, `${name}.cmb.rb`);
    writeFileSync(path, contents);
    return path;
  }

  function runCompile(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('ruby', [COMPILE_RB, ...args], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('bare (no --method) emits a {method: ir} map for every public user method', () => {
    const path = writeFixture('multi', MULTI_METHOD_FIXTURE);
    const { status, stdout, stderr } = runCompile([path]);
    expect(status, `stderr: ${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual(['alpha', 'beta']);

    // Each entry is a full IR with the method baked into entry.method.
    expect(parsed.alpha.entry).toMatchObject({
      class: 'MultiMethodGen',
      method: 'alpha',
      source: path,
    });
    expect(parsed.beta.entry).toMatchObject({
      class: 'MultiMethodGen',
      method: 'beta',
      source: path,
    });

    // Steps differ per method; everything else is shared.
    expect(parsed.alpha.steps[0].prompt).toBe('alpha');
    expect(parsed.beta.steps[0].prompt).toBe('beta');
    expect(parsed.alpha.system).toBe(parsed.beta.system);
    expect(parsed.alpha.model).toEqual(parsed.beta.model);
  });

  it('bare mode works for a single-method gen too (always returns a map)', () => {
    const path = writeFixture('single', SINGLE_METHOD_FIXTURE);
    const { status, stdout, stderr } = runCompile([path]);
    expect(status, `stderr: ${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout);
    // Always-map shape — predictable for tooling. Single method is just
    // a 1-entry map, NOT a bare IR.
    expect(Object.keys(parsed)).toEqual(['analyze']);
    expect(parsed.analyze.entry.method).toBe('analyze');
  });

  it('--method still emits a single IR (no map wrapper) — back-compat', () => {
    const path = writeFixture('multi', MULTI_METHOD_FIXTURE);
    const { status, stdout, stderr } = runCompile([path, '--method', 'alpha']);
    expect(status, `stderr: ${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout);
    // No map wrapper — top-level keys are IR fields.
    expect(parsed.entry).toMatchObject({
      class: 'MultiMethodGen',
      method: 'alpha',
      source: path,
    });
    expect(parsed.steps[0].prompt).toBe('alpha');
    // Beta is NOT in the output — --method is a filter.
    expect(parsed.steps).toHaveLength(1);
  });

  it('bare mode against a gen with no public methods raises CompileError', () => {
    const path = writeFixture('empty', NO_METHOD_FIXTURE);
    const { status, stderr } = runCompile([path]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/No public methods found on NoMethodGen/);
  });

  it('--method against a gen with no public methods still errors usefully', () => {
    const path = writeFixture('empty', NO_METHOD_FIXTURE);
    const { status, stderr } = runCompile([path, '--method', 'analyze']);
    // The CompileError surfaces as a Ruby NoMethodError or similar — we
    // assert non-zero exit, not the exact message, since the error path
    // differs from bare mode.
    expect(status).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
