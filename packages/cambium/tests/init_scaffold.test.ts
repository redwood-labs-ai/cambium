/**
 * Issue #161: `cambium init` must produce a workspace that can actually run.
 *
 * Before this, no `package.json` was written at all — so Node resolved
 * `src/contracts.ts` as CJS (module type comes from the nearest package.json
 * walking up) and `cambium run` died with ERR_REQUIRE_CYCLE_MODULE, while
 * `cambium test` had no vitest to shell out to.
 *
 * The last test is a drift guard: the scaffold's pinned dependency versions
 * are hardcoded in `cli/init.mjs`, so they can silently go stale as Cambium's
 * own pins move. This asserts they still agree with the tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-init-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function initInScratch(name = 'demoapp') {
  const result = spawnSync('node', [CLI, 'init', name], {
    cwd: scratch,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  return result;
}

function scaffoldedPkgJson(): any {
  return JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
}

describe('cambium init — scaffolded package.json (issue #161)', () => {
  it('writes a package.json at the workspace root', () => {
    initInScratch();
    expect(existsSync(join(scratch, 'package.json'))).toBe(true);
  });

  it('declares "type": "module" — the ERR_REQUIRE_CYCLE_MODULE fix', () => {
    initInScratch();
    // This is the load-bearing field. Node resolves module type from the
    // nearest package.json walking up, so one file at the workspace root
    // covers every packages/* member's src/contracts.ts.
    expect(scaffoldedPkgJson().type).toBe('module');
  });

  it('gives `cambium test` something to run', () => {
    initInScratch();
    const pkg = scaffoldedPkgJson();
    // `cambium test` shells out to `npx vitest run`.
    expect(pkg.devDependencies?.vitest).toBeDefined();
    expect(pkg.scripts?.test).toBe('vitest run');
  });

  it('declares typebox, which the scaffolded contracts.ts imports', () => {
    initInScratch();
    const contracts = readFileSync(
      join(scratch, 'packages/demoapp/src/contracts.ts'), 'utf8');
    expect(contracts).toMatch(/from '@sinclair\/typebox'/);
    expect(scaffoldedPkgJson().dependencies?.['@sinclair/typebox']).toBeDefined();
  });

  it('is a private npm workspace matching the Genfile members glob', () => {
    initInScratch();
    const pkg = scaffoldedPkgJson();
    expect(pkg.private).toBe(true);
    expect(pkg.workspaces).toEqual(['packages/*']);
    const genfile = readFileSync(join(scratch, 'Genfile.toml'), 'utf8');
    expect(genfile).toMatch(/members\s*=\s*\["packages\/\*"\]/);
  });

  it('names the scaffolded package after the init argument', () => {
    initInScratch('otherapp');
    expect(scaffoldedPkgJson().name).toBe('otherapp');
    expect(existsSync(join(scratch, 'packages/otherapp/Genfile.toml'))).toBe(true);
  });

  it('pins every dependency exactly — no ^ or ~ ranges', () => {
    initInScratch();
    const pkg = scaffoldedPkgJson();
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, range] of Object.entries(all)) {
      // Same discipline Cambium applies to its own tree (SECURITY.md
      // § Supply-chain defenses) — a scaffold that teaches ranges teaches
      // the wrong habit.
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  // ── Drift guard ──────────────────────────────────────────────────────
  it('scaffold pins still match the versions Cambium itself resolves', () => {
    initInScratch();
    const pkg = scaffoldedPkgJson();

    const rootPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const runnerPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/cambium-runner/package.json'), 'utf8'));

    // Cambium's own version — read at scaffold time, so this tracks a
    // release bump automatically rather than needing a manual edit.
    expect(pkg.dependencies['@redwood-labs/cambium']).toBe(rootPkg.version);

    // These two are hardcoded in cli/init.mjs. If a bump moves the tree but
    // not the scaffold, fail here rather than shipping a stale template.
    expect(pkg.dependencies['@sinclair/typebox'])
      .toBe(runnerPkg.dependencies['@sinclair/typebox']);
    expect(pkg.devDependencies.vitest).toBe(rootPkg.devDependencies.vitest);
  });
});
