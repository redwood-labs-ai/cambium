/**
 * RED-245: Ruby-side discovery path tests.
 *
 * Verifies the three layers of `_cambium_discovery_dirs`:
 *   1. Gen-local — `<gen_dir>/<name>.<ext>` resolved first.
 *   2. Package-app — `<gen_dir's parent>/<subdir>/<name>.<ext>`.
 *   3. Workspace fallback — cwd-relative `packages/cambium/app/<subdir>/`.
 *
 * Plus the sentinel-suppression rule: when `cambium.engine.json` is in
 * the gen's directory, only layer 1 is consulted — the walk-up dirs and
 * the workspace fallback are both suppressed.
 *
 * Tests run `ruby ruby/cambium/compile.rb` as a subprocess from the repo
 * root (so the workspace fallback resolves to the in-tree
 * `packages/cambium/app/policies/research_defaults.policy.rb` and
 * `packages/cambium/app/memory_pools/support_team.pool.rb` — both useful
 * fixtures for "the workspace fallback would have caught it" assertions).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red245-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

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

const POOL_BODY = 'strategy :sliding_window\n';
const POLICY_BODY = `
network allowlist: %w[example.com]
budget per_run: { max_calls: 5 }
`.trim();

describe('Ruby search-path discovery (RED-245)', () => {
  // ── Layer 1: gen-local ──────────────────────────────────────────────

  it('finds a co-located <name>.policy.rb next to the gen (gen-local layer)', () => {
    // The pack name `gen_local_pack` is unique — workspace fallback can't catch it.
    writeFileSync(join(scratch, 'gen_local_pack.policy.rb'), POLICY_BODY);
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class GenLocalPolicyTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :gen_local_pack
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const ir = compile(gen, 'go');
    expect(ir.policies?.security?._packs).toContain('gen_local_pack');
  });

  it('finds a co-located <name>.pool.rb next to the gen (gen-local layer)', () => {
    writeFileSync(join(scratch, 'gen_local_pool.pool.rb'), POOL_BODY);
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class GenLocalPoolTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, scope: :gen_local_pool
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const ir = compile(gen, 'go');
    const decl = (ir.policies?.memory ?? []).find((m: any) => m.name === 'x');
    expect(decl?.scope).toBe('gen_local_pool');
  });

  // ── Layer 2: package-app sibling ────────────────────────────────────

  it('finds <gen_dir parent>/policies/<name>.policy.rb (package-app layer)', () => {
    // gen at <scratch>/app/gens/g.cmb.rb -> pkg-app dir is <scratch>/app/policies/
    const gensDir = join(scratch, 'app', 'gens');
    const policiesDir = join(scratch, 'app', 'policies');
    mkdirSync(gensDir, { recursive: true });
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'pkg_app_pack.policy.rb'), POLICY_BODY);
    const gen = join(gensDir, 'g.cmb.rb');
    writeFileSync(gen, `
class PkgAppPolicyTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :pkg_app_pack
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const ir = compile(gen, 'go');
    expect(ir.policies?.security?._packs).toContain('pkg_app_pack');
  });

  // ── Layer 3: workspace fallback ─────────────────────────────────────

  it('finds packages/cambium/app/policies/<name>.policy.rb via workspace fallback', () => {
    // research_defaults ships in-tree; gen lives in scratch (no local pack).
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class WorkspaceFallbackTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :research_defaults
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const ir = compile(gen, 'go');
    expect(ir.policies?.security?._packs).toContain('research_defaults');
  });

  // ── Sentinel suppression ────────────────────────────────────────────

  it('suppresses walk-up when cambium.engine.json sits next to the gen — workspace fallback no longer reachable', () => {
    // Without the sentinel this gen would resolve `:research_defaults`
    // via the workspace fallback. With it, only gen-local is searched
    // and the pack must fail to load.
    writeFileSync(join(scratch, 'cambium.engine.json'), JSON.stringify({
      name: 'sentinel_test', version: '0.1.0', createdBy: 'test fixture',
    }));
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class SentinelSuppressionTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :research_defaults
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/Policy pack 'research_defaults' not found/);
    // Confirm the sentinel actually narrowed the search — only one
    // candidate (gen_dir) should appear in the diagnostic.
    expect(stderr).toMatch(new RegExp(`${scratch}/research_defaults\\.policy\\.rb`));
    expect(stderr).not.toMatch(/packages\/cambium\/app\/policies\/research_defaults\.policy\.rb/);
  });

  it('sentinel does NOT block gen-local discovery (engine-mode authoring still works)', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), JSON.stringify({
      name: 'sentinel_test', version: '0.1.0', createdBy: 'test fixture',
    }));
    writeFileSync(join(scratch, 'engine_local_pack.policy.rb'), POLICY_BODY);
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class SentinelGenLocalTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  security :engine_local_pack
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const ir = compile(gen, 'go');
    expect(ir.policies?.security?._packs).toContain('engine_local_pack');
  });

  it('sentinel narrows pool search the same way (memory_pools / pool.rb)', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), JSON.stringify({
      name: 'sentinel_test', version: '0.1.0', createdBy: 'test fixture',
    }));
    const gen = join(scratch, 'g.cmb.rb');
    writeFileSync(gen, `
class SentinelPoolTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :x, scope: :support_team
  def go(_x); generate "x" do; returns AnalysisReport; end; end
end
`.trim());
    const stderr = compileExpectError(gen, 'go');
    expect(stderr).toMatch(/Memory pool 'support_team' not found/);
    expect(stderr).not.toMatch(/packages\/cambium\/app\/memory_pools\/support_team\.pool\.rb/);
  });
});
