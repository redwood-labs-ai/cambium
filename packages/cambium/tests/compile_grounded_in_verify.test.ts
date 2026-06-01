/**
 * RED-392: `grounded_in :source, verify: :field_values` compiles the
 * verify strategy into `ir.policies.grounding.verify`. Invalid strategies
 * are rejected at compile time (mirrors the `from:` validation stance).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();

function compile(genPath: string, method: string, extraArgs: string[] = []): { ir: any | null; stderr: string } {
  const result = spawnSync(
    'ruby',
    [join(REPO_ROOT, 'ruby/cambium/compile.rb'), genPath, '--method', method, ...extraArgs],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) return { ir: null, stderr: result.stderr ?? '' };
  return { ir: JSON.parse(result.stdout), stderr: result.stderr ?? '' };
}

describe('RED-392: grounded_in verify: :field_values', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red392-'));
    mkdirSync(join(scratch, 'app/gens'), { recursive: true });
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(
      join(scratch, 'src/contracts.ts'),
      `import { Type } from '@sinclair/typebox'
export const AnalysisReport = Type.Object({}, { additionalProperties: true, $id: 'AnalysisReport' })
`,
    );
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writeGen(body: string): string {
    const path = join(scratch, 'app/gens/grounded.cmb.rb');
    writeFileSync(path, body.trim());
    return path;
  }

  it('bakes verify: :field_values into policies.grounding.verify', () => {
    writeFileSync(join(scratch, 'app/gens/report.txt'), 'body');
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "report.txt", verify: :field_values
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(stderr).toBe('');
    expect(ir.policies.grounding).toMatchObject({
      source: 'report',
      from: 'report.txt',
      verify: 'field_values',
    });
  });

  it('omits the verify field when not declared (back-compat)', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :doc, require_citations: true
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const arg = join(scratch, 'arg.txt');
    writeFileSync(arg, 'doc body');
    const { ir, stderr } = compile(gen, 'analyze', ['--arg', arg]);
    expect(stderr).toBe('');
    expect(ir.policies.grounding.verify).toBeUndefined();
  });

  it('rejects an unknown verify: strategy at compile time', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :doc, verify: :semantic_similarity
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const arg = join(scratch, 'arg.txt');
    writeFileSync(arg, 'doc body');
    const { ir, stderr } = compile(gen, 'analyze', ['--arg', arg]);
    expect(ir).toBeNull();
    expect(stderr).toMatch(/verify: must be nil or one of :field_values/);
  });
});
