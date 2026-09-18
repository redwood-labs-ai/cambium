/**
 * #282: a scaffolded test must not bake the scaffolding machine's absolute
 * paths into the file it commits.
 *
 * #199 extracted `cambium new agent`'s golden-test template into the shared
 * `goldenTestSource` so `cambium promote` could reuse it byte-for-byte, and
 * in doing so changed GEN/FIXTURE/SNAPSHOT from repo-relative joins to
 * absolute literals (DEC-009, to avoid a double-join). Absolute is correct
 * only on the machine that ran the scaffolder: the generated test is a
 * committed file, so every collaborator and every CI checkout got a test
 * that could not find its own gen. Caught when the in-tree TicketRouter
 * golden (#275) — the first test committed from the new template — failed
 * CI with `cannot load such file -- /Users/<author>/dev/cambium/...`.
 *
 * The guard is the scratch-directory property: scaffold into a temp dir,
 * assert the emitted source contains no reference to that directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-scaffold-paths-')));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

describe('#282: scaffolded tests are location-independent', () => {
  it('cambium new agent emits a golden test with no absolute scaffold-time paths', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "pathtest"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'agent', 'PriceWatcher']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const testPath = join(scratch, 'tests', 'price_watcher.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const body = readFileSync(testPath, 'utf8');

    // The load-bearing assertion: nothing in the committed file points at
    // the directory the scaffolder happened to run in.
    expect(body).not.toContain(scratch);

    // ...and the paths it does use are anchored on the file's own location,
    // not on process.cwd() (which is the workspace root, not appPkgRoot).
    expect(body).toContain('fileURLToPath(import.meta.url)');
    expect(body).toMatch(/const GEN = join\(PKG_ROOT, "app\/gens\/price_watcher\.cmb\.rb"\)/);
    expect(body).toMatch(/const SNAPSHOT = join\(PKG_ROOT, "examples\/fixtures\/price_watcher-snapshot\.json"\)/);
  });

  it('cambium new pipeline emits a test with no absolute scaffold-time paths', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "pathtest"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'pipeline', 'DailyRollup']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const testPath = join(scratch, 'tests', 'daily_rollup.pipeline.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const body = readFileSync(testPath, 'utf8');

    expect(body).not.toContain(scratch);
    expect(body).toContain('fileURLToPath(import.meta.url)');
    expect(body).toMatch(/const PIPELINE = join\(PKG_ROOT, 'app\/pipelines\/daily_rollup\.pipeline\.rb'\)/);
  });
});
