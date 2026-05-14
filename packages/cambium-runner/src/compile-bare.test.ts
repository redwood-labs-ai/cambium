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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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


// ── RED-373: schema-validator contracts-search ────────────────────────
//
// Pre-RED-373, the schema-name validator in compile.rb had two stacked
// bugs: `pkg_dir` was one level too shallow (resolved to `<workspace>/app`
// instead of `<workspace>`), AND a cwd-relative fallback to
// `packages/cambium/src/contracts.ts` could match the WRONG workspace's
// contracts when the operator ran from a Cambium repo cwd pointed at an
// external workspace.
//
// These tests pin the fix: schema lookup MUST go through the gen's own
// workspace, and a cwd that happens to contain `packages/cambium/...`
// (e.g. running the test from the cambium repo root — which is exactly
// how this suite runs) MUST NOT leak in.

const RED_373_FIXTURE_GEN = `
class WorkspaceGen < GenModel
  model "ollama:test"
  system "test"
  returns WorkspaceLocalSchema

  def analyze(input)
    generate "do" do
      returns WorkspaceLocalSchema
    end
  end
end
`;

const RED_373_FIXTURE_CONTRACTS = `
export const WorkspaceLocalSchema = {
  $id: 'WorkspaceLocalSchema',
  type: 'object',
  additionalProperties: true,
};
`;

describe('compile.rb schema validator (RED-373)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-red373-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildWorkspace(): { genPath: string } {
    // Layout matches both [package] (flat) and the gen-under-app/gens
    // convention. workspace_dir = two levels up from gen_dir → tmp.
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'app/gens/workspace_gen.cmb.rb'), RED_373_FIXTURE_GEN);
    writeFileSync(join(tmp, 'src/contracts.ts'), RED_373_FIXTURE_CONTRACTS);
    return { genPath: join(tmp, 'app/gens/workspace_gen.cmb.rb') };
  }

  function runCompileFromCwd(
    args: string[],
    cwd?: string,
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('ruby', [COMPILE_RB, ...args], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      cwd,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('finds schema in the workspace`s own src/contracts.ts (two levels up from app/gens)', () => {
    // The schema lives ONLY in tmp/src/contracts.ts — NOT in any
    // cwd-relative `packages/cambium/src/contracts.ts`. Pre-RED-373
    // the validator built contracts_candidates with a one-level-up
    // pkg_dir → `tmp/app/src/contracts.ts` (doesn't exist) and would
    // fall through to the cwd-relative fallback. Now it walks two
    // levels up to tmp/ and finds the workspace's own contracts.
    const { genPath } = buildWorkspace();
    const { status, stdout, stderr } = runCompileFromCwd([genPath]);
    expect(status, `stderr: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.analyze.returnSchemaId).toBe('WorkspaceLocalSchema');
  });

  it('rejects schema not in workspace contracts (the in-repo packages/cambium contracts MUST NOT leak)', () => {
    // The default cwd for this test process is the cambium repo root,
    // which has a `packages/cambium/src/contracts.ts` with schemas like
    // `AnalysisReport`. Pre-RED-373 the cwd-relative fallback would
    // find it and either (a) validate against the wrong schemas or
    // (b) succeed/fail for the wrong reason. Now the cwd fallback is
    // gone — `Ghost` legitimately doesn't exist in tmp/src/contracts.ts,
    // and the validator must error with the workspace's contracts as
    // the source of truth.
    const ghostGen = `
class GhostGen < GenModel
  model "ollama:test"
  system "test"
  returns Ghost

  def analyze(input)
    generate "do" do
      returns Ghost
    end
  end
end
`;
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'app/gens/ghost.cmb.rb'), ghostGen);
    writeFileSync(join(tmp, 'src/contracts.ts'), RED_373_FIXTURE_CONTRACTS); // has WorkspaceLocalSchema, NOT Ghost
    const { status, stderr } = runCompileFromCwd([
      join(tmp, 'app/gens/ghost.cmb.rb'),
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Unknown schema 'Ghost'/);
    // The "Available schemas" listing MUST come from the workspace's
    // own contracts, NOT from the in-repo packages/cambium contracts.
    expect(stderr).toMatch(/WorkspaceLocalSchema/);
    expect(stderr).not.toMatch(/AnalysisReport/);
  });

  it('skips validation (best-effort) when the workspace has no src/contracts.ts', () => {
    // Workspace with NO contracts file at all — no engine schemas.ts
    // sibling, no workspace src/contracts.ts. The validator falls
    // through (contracts_candidates is empty); the gen compiles.
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/orphan.cmb.rb'), `
class OrphanGen < GenModel
  model "ollama:test"
  system "test"
  returns SomeSchemaWeCantFind

  def analyze(input)
    generate "do" do
      returns SomeSchemaWeCantFind
    end
  end
end
`);
    const { status, stderr } = runCompileFromCwd([
      join(tmp, 'app/gens/orphan.cmb.rb'),
    ]);
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  it('finds schema in the engine-mode sibling schemas.ts (preserves the engine-mode path)', () => {
    // RED-287 path: engine gens declare a sibling schemas.ts in the
    // same directory as the gen. RED-373's fix to walk-up-two-levels
    // must not break this.
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/engine_gen.cmb.rb'), RED_373_FIXTURE_GEN);
    writeFileSync(join(tmp, 'app/gens/schemas.ts'), RED_373_FIXTURE_CONTRACTS);
    const { status, stderr } = runCompileFromCwd([
      join(tmp, 'app/gens/engine_gen.cmb.rb'),
    ]);
    expect(status, `stderr: ${stderr}`).toBe(0);
  });
});
