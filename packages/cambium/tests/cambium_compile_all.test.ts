/**
 * RED-407: `cambium compile` with NO file — recompile every gen/pipeline IR
 * in the workspace. Mode-aware:
 *   - engine mode (cambium.engine.json) → writes each <base>.ir.json
 *   - app mode (Genfile.toml) → validate-only; --out-dir/--write to materialize
 * Compiles all, reports, exits non-zero if any failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'cambium-red407-'));
});
afterEach(() => {
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
});

// Run the CLI with cwd = the test workspace so mode detection + enumeration
// resolve against it (the Ruby compiler is invoked by absolute path, so it
// works regardless of cwd).
function runCli(args: string[], cwd = ws) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

const GEN = (cls: string) =>
  `class ${cls} < GenModel\n  model "omlx:stub"\n  system "inline"\n  returns AnalysisReport\n  def analyze(input)\n    generate "go" do\n      with context: input\n      returns AnalysisReport\n    end\n  end\nend\n`;

const CONTRACTS = `import { Type } from '@sinclair/typebox';\nexport const AnalysisReport = Type.Object({ summary: Type.String() }, { additionalProperties: false, $id: 'AnalysisReport' });\n`;

function appWorkspace(gens: Record<string, string>): void {
  writeFileSync(join(ws, 'Genfile.toml'), `[package]\nname = "wstest"\nversion = "0.0.0"\n\n[types]\ncontracts = ["contracts.ts"]\n`);
  writeFileSync(join(ws, 'contracts.ts'), CONTRACTS);
  mkdirSync(join(ws, 'app', 'gens'), { recursive: true });
  for (const [name, body] of Object.entries(gens)) {
    writeFileSync(join(ws, 'app', 'gens', name), body);
  }
}

describe('cambium compile (no file) — compile-all (RED-407)', () => {
  it('app mode is validate-only: compiles all, writes nothing, exit 0', () => {
    appWorkspace({ 'foo.cmb.rb': GEN('Foo'), 'bar.cmb.rb': GEN('Bar') });
    const r = runCli(['compile']);
    expect(r.status).toBe(0);
    const out = (r.stderr ?? '') + (r.stdout ?? '');
    expect(out).toMatch(/validated 2 gen\(s\) — all compile/);
    expect(out).toMatch(/no IRs written/);
    // No .ir.json materialized next to sources.
    expect(existsSync(join(ws, 'app', 'gens', 'foo.ir.json'))).toBe(false);
    expect(existsSync(join(ws, 'app', 'gens', 'bar.ir.json'))).toBe(false);
  });

  it('--out-dir materializes every IR without touching the source tree', () => {
    appWorkspace({ 'foo.cmb.rb': GEN('Foo'), 'bar.cmb.rb': GEN('Bar') });
    const outDir = join(ws, 'dist');
    const r = runCli(['compile', '--out-dir', outDir]);
    expect(r.status).toBe(0);
    expect(existsSync(join(outDir, 'foo.ir.json'))).toBe(true);
    expect(existsSync(join(outDir, 'bar.ir.json'))).toBe(true);
    // Source tree stays clean.
    expect(existsSync(join(ws, 'app', 'gens', 'foo.ir.json'))).toBe(false);
  });

  it('engine mode writes <base>.ir.json next to each gen', () => {
    writeFileSync(join(ws, 'cambium.engine.json'), '{}');
    writeFileSync(join(ws, 'schemas.ts'), CONTRACTS);
    writeFileSync(join(ws, 'echo.cmb.rb'), GEN('Echo'));
    const r = runCli(['compile']);
    expect(r.status).toBe(0);
    expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/engine mode/);
    expect(existsSync(join(ws, 'echo.ir.json'))).toBe(true);
  });

  it('compiles all then exits non-zero when any gen fails', () => {
    appWorkspace({ 'ok.cmb.rb': GEN('Okay'), 'broken.cmb.rb': 'class Broken < GenModel\n  not valid ruby!!!\nend\n' });
    const r = runCli(['compile']);
    expect(r.status).toBe(1);
    const out = (r.stderr ?? '') + (r.stdout ?? '');
    expect(out).toMatch(/1\/2 ok, 1 failed/);
    expect(out).toMatch(/broken\.cmb\.rb/);
  });

  it('errors clearly when not inside a Cambium workspace', () => {
    const bare = mkdtempSync(join(tmpdir(), 'cambium-red407-bare-'));
    try {
      const r = runCli(['compile'], bare);
      expect(r.status).not.toBe(0);
      expect((r.stderr ?? '') + (r.stdout ?? '')).toMatch(/not in a Cambium workspace/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
