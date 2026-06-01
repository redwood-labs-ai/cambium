/**
 * RED-397: `--arg -` forwards the parent's real piped stdin to the Ruby
 * compiler. Before the fix, the pipe reached Node but was never passed to
 * the child, so `STDIN.read` returned empty and the gen ran against
 * `context.document: ""` — a silent-wrong-result bug.
 *
 * Driven through the real CLI (`cli/compile.mjs`) with spawnSync's `input`
 * simulating the pipe. compile is used (not run) so the assertion is on the
 * emitted IR's context — no model backend needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readExplicitStdinArg } from '../../../cli/stdin-arg.mjs';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

describe('RED-397: --arg - forwards piped stdin', () => {
  let scratch: string;
  let gen: string;
  let out: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red397-'));
    mkdirSync(join(scratch, 'app/gens'), { recursive: true });
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(
      join(scratch, 'src/contracts.ts'),
      `import { Type } from '@sinclair/typebox'
export const AnalysisReport = Type.Object({}, { additionalProperties: true, $id: 'AnalysisReport' })
`,
    );
    gen = join(scratch, 'app/gens/q.cmb.rb');
    writeFileSync(
      gen,
      `
class Q < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :document
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`.trim(),
    );
    out = join(scratch, 'q.ir.json');
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function compileWithStdin(input: string | undefined, extraArgs: string[]) {
    return spawnSync(
      'node',
      [CLI, 'compile', gen, '--method', 'analyze', ...extraArgs, '-o', out],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, input },
    );
  }

  it('pipes stdin into ir.context.<source> when --arg - is explicit', () => {
    const piped = 'Latency p95 jumped to 800ms during the incident.';
    const r = compileWithStdin(piped, ['--arg', '-']);
    expect(r.status).toBe(0);
    const ir = JSON.parse(readFileSync(out, 'utf8'));
    expect(ir.context.document).toBe(piped); // the pre-RED-397 bug returned ""
  });

  it('forwards JSON payloads verbatim through --arg -', () => {
    const piped = '{"k": "v", "n": 7}';
    const r = compileWithStdin(piped, ['--arg', '-']);
    expect(r.status).toBe(0);
    const ir = JSON.parse(readFileSync(out, 'utf8'));
    expect(ir.context.document).toBe(piped);
  });
});

describe('RED-397: readExplicitStdinArg TTY guard', () => {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  });
  afterEach(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original);
    else delete (process.stdin as any).isTTY;
  });

  it('throws a clear error when stdin is a TTY (nothing piped)', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    expect(() => readExplicitStdinArg('cambium run')).toThrow(/stdin is a terminal/);
  });
});
