/**
 * #205 A-002 (DEC-008): a `Genfile.toml` with no `[types]` section is app
 * mode with NO contracts declared — not "no Genfile at all." Before A-002,
 * `runGenFromIr` treated the two the same and fell back to importing the
 * in-tree monorepo's own `packages/cambium/src/contracts.ts`, which
 * doesn't exist in an external `[package]` workspace and crashed with
 * `ERR_MODULE_NOT_FOUND` — even for a gen whose schema is fully inline and
 * never reads the contracts module at all.
 *
 * Drives the real CLI against a flat `[package]` scratch with no `[types]`
 * section and no `src/contracts.ts` anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-genfile-no-types-'));
  mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
  writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "notypestest"\nversion = "0.0.0"\n`);
  // RED-306: tsx's programmatic register() honors the nearest package.json's
  // "type" field; real external apps declare "type": "module" (same fixture
  // shape as engine_mode_e2e.test.ts's setupEngine).
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'notypestest', type: 'module', private: true }) + '\n',
  );
  writeFileSync(join(scratch, 'doc.txt'), 'hello world\n');
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

describe('#205 A-002: Genfile without [types] is app mode with no contracts', () => {
  it('an inline-schema gen runs --mock to exit 0; a symbol-form gen in the SAME scratch fails loudly at "Schema not found" (not ERR_MODULE_NOT_FOUND)', () => {
    const inlineGen = join(scratch, 'app', 'gens', 'inline_gen.cmb.rb');
    writeFileSync(
      inlineGen,
      `
class InlineGen < GenModel
  model "omlx:stub"
  system "inline"
  returns do
    field :summary, String
  end
  def analyze(document)
    generate "say something" do
      with context: document
    end
  end
end
`.trim(),
    );

    const okResult = runCli(['run', inlineGen, '--method', 'analyze', '--arg', join(scratch, 'doc.txt'), '--mock']);
    expect(okResult.status, (okResult.stderr ?? '') + (okResult.stdout ?? '')).toBe(0);
    expect(JSON.parse(okResult.stdout).summary).toBe('mock summary');

    // Same scratch, same missing-[types] Genfile — a symbol-form gen has
    // nowhere to resolve its schema and must fail LOUDLY, not crash on an
    // unrelated missing-module error.
    const symbolGen = join(scratch, 'app', 'gens', 'symbol_gen.cmb.rb');
    writeFileSync(
      symbolGen,
      `
class SymbolGen < GenModel
  model "omlx:stub"
  system "inline"
  returns SomeUndeclaredSchema
  def analyze(document)
    generate "say something" do
      with context: document
      returns SomeUndeclaredSchema
    end
  end
end
`.trim(),
    );

    const failResult = runCli(['run', symbolGen, '--method', 'analyze', '--arg', join(scratch, 'doc.txt'), '--mock']);
    expect(failResult.status).not.toBe(0);
    expect(failResult.stderr).toMatch(/Schema not found/);
    expect(failResult.stderr).toMatch(/\[types\]\.contracts/);
    expect(failResult.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
  });

  it('app correctors (RED-275) are discovered in a [types]-less workspace', () => {
    mkdirSync(join(scratch, 'app', 'correctors'), { recursive: true });
    // Untyped on purpose — a `.corrector.ts` under an external [package]
    // app has no `cambium-runner` sibling to import types from; `tsx`
    // (registered by the CLI) transpiles without type-checking, so this
    // runs exactly like a real external app's corrector would.
    writeFileSync(
      join(scratch, 'app', 'correctors', 'shout.corrector.ts'),
      `
export const shout = (data, _context) => {
  const output = { ...data };
  if (typeof output.summary === 'string') output.summary = output.summary.toUpperCase();
  return { corrected: typeof data.summary === 'string', output, issues: [] };
};
`.trim(),
    );

    const gen = join(scratch, 'app', 'gens', 'shout_gen.cmb.rb');
    writeFileSync(
      gen,
      `
class ShoutGen < GenModel
  model "omlx:stub"
  system "inline"
  corrects :shout
  returns do
    field :summary, String
  end
  def analyze(document)
    generate "say something" do
      with context: document
    end
  end
end
`.trim(),
    );

    const tracePath = join(scratch, 'trace.json');
    const result = runCli([
      'run', gen, '--method', 'analyze', '--arg', join(scratch, 'doc.txt'), '--mock', '--trace', tracePath,
    ]);
    expect(result.status, (result.stderr ?? '') + (result.stdout ?? '')).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.summary).toBe('MOCK SUMMARY');

    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const correctStep = trace.steps.find((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('shout'));
    expect(correctStep).toBeDefined();
  });
});
