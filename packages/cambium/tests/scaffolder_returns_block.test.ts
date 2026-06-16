/**
 * RED-419 C4 / STEP-005: `cambium new agent` scaffolds a `returns do …
 * end` block by default (the one-file on-ramp). The scaffolded gen must
 * compile via the inline-schema path with NO contracts.ts entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

  it('engine-mode `cambium new agent` also emits a returns do block', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const r = runCli(['new', 'agent', 'Digester']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    const body = readFileSync(join(scratch, 'digester.cmb.rb'), 'utf8');
    expect(body).toMatch(/returns do/);
    expect(body).not.toMatch(/returns\s+DigesterReport/);
  });
});
