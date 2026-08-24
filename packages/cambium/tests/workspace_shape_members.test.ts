/**
 * RED-159: `[workspace]` shape must resolve `appPkgRoot` from the Genfile's
 * `members`, not from a hardcoded `packages/cambium/`.
 *
 * Before this, `cambium init demoapp` wrote `packages/demoapp/` while shape
 * detection always answered `packages/cambium/`, so `cambium new agent Foo`
 * scaffolded into a directory nothing else referenced. Only
 * `cambium init cambium` happened to work.
 *
 * The companion half is the scaffolded runner import: `ctx.shape ===
 * 'workspace'` was standing in for "is the cambium monorepo", so external
 * workspace-shaped apps got a deep relative into a `packages/cambium-runner/`
 * they do not have. See generate.mjs `runnerImport`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectWorkspaceShape } from '../../../cli/workspace-shape.mjs';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red159-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

/** Write a [workspace] root plus member packages with the given kinds. */
function makeWorkspace(
  members: Array<{ name: string; kinds?: string[] | null }>,
  membersGlob = '["packages/*"]',
) {
  writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ${membersGlob}\n`);
  for (const m of members) {
    const dir = join(scratch, 'packages', m.name);
    mkdirSync(join(dir, 'app/gens'), { recursive: true });
    const kinds = m.kinds === null ? '' : `kinds = ${JSON.stringify(m.kinds ?? ['app'])}\n`;
    writeFileSync(join(dir, 'Genfile.toml'),
      `[package]\nname = "${m.name}"\nversion = "0.1.0"\n${kinds}`);
  }
}

/** A member directory with no Genfile — must never be selected. */
function makeBareDir(name: string) {
  mkdirSync(join(scratch, 'packages', name, 'src'), { recursive: true });
}

describe('detectWorkspaceShape — appPkgRoot from members (RED-159)', () => {
  it('resolves the single app member, whatever it is called', () => {
    makeWorkspace([{ name: 'demoapp' }]);
    const r = detectWorkspaceShape(scratch)!;
    expect(r.shape).toBe('workspace');
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'demoapp'));
  });

  it('ignores member dirs with no Genfile', () => {
    makeWorkspace([{ name: 'demoapp' }]);
    makeBareDir('cambium-runner'); // a sibling that is not a Cambium package
    const r = detectWorkspaceShape(scratch)!;
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'demoapp'));
  });

  it('prefers a member declaring kinds = ["app"] over one that does not', () => {
    makeWorkspace([
      { name: 'tooling-only', kinds: ['tooling'] },
      { name: 'theapp', kinds: ['app'] },
    ]);
    expect(detectWorkspaceShape(scratch)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'theapp'));
  });

  it('falls back to any Genfile member when none declares kinds', () => {
    makeWorkspace([{ name: 'legacy', kinds: null }]);
    expect(detectWorkspaceShape(scratch)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'legacy'));
  });

  it('honors explicit (non-glob) member paths', () => {
    makeWorkspace([{ name: 'alpha' }], '["packages/alpha"]');
    expect(detectWorkspaceShape(scratch)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'alpha'));
  });

  it('with several app members, the one containing cwd wins', () => {
    makeWorkspace([{ name: 'alpha' }, { name: 'beta' }]);
    const from = join(scratch, 'packages', 'beta', 'app', 'gens');
    expect(detectWorkspaceShape(from)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'beta'));
  });

  it('with several app members and no containing cwd, reports the ambiguity', () => {
    makeWorkspace([{ name: 'alpha' }, { name: 'beta' }]);
    // Guessing here is how the original bug silently orphaned files.
    expect(() => detectWorkspaceShape(scratch)).toThrow(/Ambiguous workspace/);
  });

  it('falls back to packages/cambium when members yield nothing', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/*"]\n`);
    mkdirSync(join(scratch, 'packages'), { recursive: true });
    expect(detectWorkspaceShape(scratch)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'cambium'));
  });

  it('refuses members that escape the workspace root', () => {
    makeWorkspace([{ name: 'demoapp' }], '["../outside", "packages/*"]');
    // The `..` pattern is dropped, not joined — the real member still wins.
    expect(detectWorkspaceShape(scratch)!.appPkgRoot)
      .toBe(join(scratch, 'packages', 'demoapp'));
  });

  it('still resolves the cambium monorepo to packages/cambium', () => {
    // Back-compat: the repo this test runs in is the original [workspace]
    // case the hardcode was written for.
    const r = detectWorkspaceShape(REPO_ROOT)!;
    expect(r.shape).toBe('workspace');
    expect(r.appPkgRoot).toBe(join(REPO_ROOT, 'packages', 'cambium'));
  });
});

describe('scaffolders — runner import is shape-correct (RED-159)', () => {
  function initAndScaffold(args: string[][]) {
    const init = spawnSync('node', [CLI, 'init', 'demoapp'], {
      cwd: scratch, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    expect(init.status).toBe(0);
    for (const a of args) {
      const r = spawnSync('node', [CLI, 'new', ...a], {
        cwd: scratch, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
      expect(r.status, `cambium new ${a.join(' ')} failed:\n${r.stderr}`).toBe(0);
    }
  }

  it('an external [workspace] app imports the published runner, not a deep relative', () => {
    initAndScaffold([
      ['agent', 'Foo'], ['tool', 'Bar'], ['action', 'Baz'],
      ['corrector', 'Qux'], ['provider', 'Bedrock'],
    ]);
    const pkg = join(scratch, 'packages', 'demoapp');
    const files = [
      'tests/foo.test.ts',
      'app/tools/bar.tool.ts',
      'app/actions/baz.action.ts',
      'app/correctors/qux.corrector.ts',
      'app/providers/bedrock.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(pkg, f), 'utf8');
      // The deep relative would resolve to a packages/cambium-runner/ that
      // does not exist here — ERR_MODULE_NOT_FOUND on first run.
      expect(src, `${f} kept the monorepo-relative import`)
        .not.toMatch(/\.\.\/\.\.\/\.\.\/cambium-runner/);
      expect(src).toMatch(/@redwood-labs\/cambium-runner/);
    }
  });

  // The in-tree half. Each scaffold writes to a different depth under
  // appPkgRoot, so each needs a different number of `../`. Getting that
  // wrong is silent — the file is written fine and only fails when someone
  // runs it — which is how `tests/` shipped with the `app/<type>/` literal
  // and produced a golden test that could not load at all.
  //
  // Table mirrors the `runnerImport(ctx, ...)` call sites in generate.mjs.
  const DEEP_RELATIVES: Array<[string, string]> = [
    ['tests', '../../cambium-runner/src/golden.js'],
    ['app/tools', '../../../cambium-runner/src/tools/tool-context.js'],
    ['app/actions', '../../../cambium-runner/src/tools/tool-context.js'],
    ['app/correctors', '../../../cambium-runner/src/correctors/types.js'],
    ['app/providers', '../../../cambium-runner/src/providers/factories.js'],
  ];

  it('every in-tree deep relative resolves to a real runner module', () => {
    const appPkgRoot = join(REPO_ROOT, 'packages', 'cambium');
    for (const [dir, spec] of DEEP_RELATIVES) {
      // Scaffolds emit `.js` specifiers; the sources on disk are `.ts`.
      const target = join(appPkgRoot, dir, spec).replace(/\.js$/, '.ts');
      expect(existsSync(target), `${dir} → ${spec} resolves to ${target}`).toBe(true);
    }
  });

  it('the table above covers every runnerImport call site', () => {
    // Drift guard: a sixth scaffold that takes a runner import must add a
    // row here, or its depth goes unchecked.
    const src = readFileSync(join(REPO_ROOT, 'cli/generate.mjs'), 'utf8');
    // Require a string-literal argument so the function definition itself
    // (`function runnerImport(ctx, deepRelative)`) is not counted.
    const sites = src.match(/runnerImport\(ctx, '/g) ?? [];
    expect(sites.length).toBe(DEEP_RELATIVES.length);
  });

  it('scaffolds into the package init created, not packages/cambium', () => {
    initAndScaffold([['agent', 'Foo']]);
    expect(existsSync(join(scratch, 'packages/demoapp/app/gens/foo.cmb.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'packages/cambium'))).toBe(false);
  });
});
