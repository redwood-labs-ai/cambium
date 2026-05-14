/**
 * RED-244: `cambium compile` subcommand integration tests.
 *
 * Same Ruby pipeline as `cambium run`; the difference is that we write
 * the IR to disk instead of executing it. Tests cover:
 *   - default output path (<basename>.ir.json next to the input)
 *   - explicit `-o <path>` override
 *   - --arg optional (omitted → empty string fed to gen method)
 *   - --arg honored when supplied
 *   - missing --method errors out with non-zero exit
 *   - compile errors propagate (non-zero exit; the Ruby diagnostic prints)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red244-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[]) {
  // cwd stays at REPO_ROOT so the Ruby compiler can locate runtime.rb
  // via the `ruby ruby/cambium/compile.rb ...` invocation.
  return spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

function writeMinimalGen(): string {
  // Scaffold an engine-mode sentinel + sibling schemas.ts so the RED-287
  // source-anchored schema validator has a contracts surface to discover.
  // Pre-RED-373 the cwd-relative `packages/cambium/src/contracts.ts`
  // fallback covered this; that fallback was removed and tests now
  // declare their own contracts surface.
  writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
  writeFileSync(join(scratch, 'schemas.ts'), `
import { Type } from '@sinclair/typebox';
export const AnalysisReport = Type.Object({ summary: Type.String() }, { additionalProperties: false, $id: 'AnalysisReport' });
`.trim());
  const gen = join(scratch, 'foo.cmb.rb');
  writeFileSync(gen, `
class CompileSubcommandTest < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim());
  return gen;
}

describe('cambium compile (RED-244)', () => {
  it('writes IR to <basename>.ir.json next to the input when -o is omitted', () => {
    const gen = writeMinimalGen();
    const result = runCli(['compile', gen, '--method', 'analyze']);
    expect(result.status).toBe(0);

    const expectedOut = join(scratch, 'foo.ir.json');
    expect(existsSync(expectedOut)).toBe(true);

    const ir = JSON.parse(readFileSync(expectedOut, 'utf8'));
    expect(ir.entry?.method).toBe('analyze');
    expect(ir.returnSchemaId).toBe('AnalysisReport');
  });

  it('honors -o to write the IR to a custom path', () => {
    const gen = writeMinimalGen();
    const customOut = join(scratch, 'custom-name.json');
    const result = runCli(['compile', gen, '--method', 'analyze', '-o', customOut]);
    expect(result.status).toBe(0);
    expect(existsSync(customOut)).toBe(true);
    expect(existsSync(join(scratch, 'foo.ir.json'))).toBe(false); // default path NOT written
  });

  it('omitting --arg defaults to empty string in the gen method', () => {
    // The gen's `with context: input` will receive '' when --arg is absent.
    // The IR's context.document should reflect that.
    const gen = writeMinimalGen();
    const result = runCli(['compile', gen, '--method', 'analyze']);
    expect(result.status).toBe(0);

    const ir = JSON.parse(readFileSync(join(scratch, 'foo.ir.json'), 'utf8'));
    expect(ir.context?.document).toBe('');
  });

  it('honors --arg when supplied (reads file contents into the gen method)', () => {
    const gen = writeMinimalGen();
    const fixture = join(scratch, 'fixture.txt');
    writeFileSync(fixture, 'hello from fixture');

    const result = runCli(['compile', gen, '--method', 'analyze', '--arg', fixture]);
    expect(result.status).toBe(0);

    const ir = JSON.parse(readFileSync(join(scratch, 'foo.ir.json'), 'utf8'));
    expect(ir.context?.document).toBe('hello from fixture');
  });

  it('errors out without --method', () => {
    const gen = writeMinimalGen();
    const result = runCli(['compile', gen]);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? '')).toMatch(/Missing --method/);
  });

  it('propagates compile errors with non-zero exit and the Ruby diagnostic', () => {
    // Same engine-sentinel scaffold as writeMinimalGen() so the
    // validator has a contracts surface to compare against. The
    // sibling schemas.ts intentionally does NOT export
    // SchemaThatDoesNotExist — that's the typo we want rejected.
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    writeFileSync(join(scratch, 'schemas.ts'), `
import { Type } from '@sinclair/typebox';
export const AnalysisReport = Type.Object({ summary: Type.String() }, { additionalProperties: false, $id: 'AnalysisReport' });
`.trim());
    const gen = join(scratch, 'broken.cmb.rb');
    writeFileSync(gen, `
class BrokenCompileTest < GenModel
  model "omlx:stub"
  system "inline"
  returns SchemaThatDoesNotExist

  def analyze(input)
    generate "go" do
      with context: input
      returns SchemaThatDoesNotExist
    end
  end
end
`.trim());

    const result = runCli(['compile', gen, '--method', 'analyze']);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/Schema.*not.*found|SchemaThatDoesNotExist|Unknown schema/i);
    // No output file should have been written when compile fails.
    expect(existsSync(join(scratch, 'broken.ir.json'))).toBe(false);
  });
});
