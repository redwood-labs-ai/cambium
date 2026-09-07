/**
 * RED-419 C4 / STEP-005: `cambium new agent` scaffolds a `returns do …
 * end` block by default (the one-file on-ramp). The scaffolded gen must
 * compile via the inline-schema path with NO contracts.ts entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const COMPILE_RB = join(REPO_ROOT, 'ruby/cambium/compile.rb');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-scaffold-returns-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[], cwd = scratch) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

describe('RED-419 scaffolder defaults to returns do (STEP-005)', () => {
  it('scaffolds a returns do block that compiles to an inline returnSchema with no contracts.ts', () => {
    // Flat [package] workspace, NO src/contracts.ts.
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "scaffoldtest"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'agent', 'PriceWatcher']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const genPath = join(scratch, 'app', 'gens', 'price_watcher.cmb.rb');
    expect(existsSync(genPath)).toBe(true);

    const body = readFileSync(genPath, 'utf8');
    // The default schema is a returns-do block, NOT `returns :Symbol`.
    expect(body).toMatch(/returns do/);
    expect(body).toMatch(/field :summary, String/);
    expect(body).not.toMatch(/returns\s+PriceWatcherReport/);

    // It compiles via the inline path — no contracts.ts in the workspace.
    expect(existsSync(join(scratch, 'src', 'contracts.ts'))).toBe(false);
    const compile = spawnSync('ruby', [COMPILE_RB, genPath, '--method', 'analyze'], {
      encoding: 'utf8',
      maxBuffer: 5e7,
    });
    expect(compile.status, compile.stderr).toBe(0);
    const ir = JSON.parse(compile.stdout);
    expect(ir.returnSchema).toBeTruthy();
    expect(ir.returnSchema.$id).toBe('PriceWatcherOutput');
    expect(ir.returnSchema.properties.summary).toEqual({
      type: 'string',
      description: 'one-paragraph summary',
    });
    expect(ir.returnSchemaId).toBeUndefined();
  });

  it('#205 (DEC-005/A-002): a scaffolded gen edited to add fields the default mock lacks runs --mock to exit 0', () => {
    // Flat [package] workspace, NO src/contracts.ts, NO [types] section at
    // all — the shape RED-419's "one file, run it" promise is about, and
    // (A-002) the shape that used to crash `cambium run` with
    // ERR_MODULE_NOT_FOUND before Generate ever ran.
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "scaffoldtest"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'agent', 'PriceWatcher']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const genPath = join(scratch, 'app', 'gens', 'price_watcher.cmb.rb');
    const body = readFileSync(genPath, 'utf8');
    // Add fields the default mock payload ({summary, metrics, key_facts})
    // lacks — the ticket's headline case for the schema-derived mock.
    const edited = body.replace(
      '    field :key_points, [String]\n  end',
      '    field :key_points, [String]\n    field :score, Float\n    field :tags, [String]\n  end',
    );
    expect(edited).not.toBe(body);
    writeFileSync(genPath, edited);

    mkdirSync(join(scratch, 'examples', 'fixtures'), { recursive: true });
    const fixturePath = join(scratch, 'examples', 'fixtures', 'price.txt');
    writeFileSync(fixturePath, 'BTC is up 3% today.\n');

    const result = runCli(['run', genPath, '--method', 'analyze', '--arg', fixturePath, '--mock']);
    expect(result.status, (result.stderr ?? '') + (result.stdout ?? '')).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.summary).toBe('mock summary');
    expect(output.key_points).toEqual(['mock key_points']);
    expect(output.score).toBe(0);
    expect(output.tags).toEqual(['mock tags']);
  });

  it('engine-mode `cambium new agent` also emits a returns do block', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const r = runCli(['new', 'agent', 'Digester']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    const body = readFileSync(join(scratch, 'digester.cmb.rb'), 'utf8');
    expect(body).toMatch(/returns do/);
    expect(body).not.toMatch(/returns\s+DigesterReport/);
  });
});
