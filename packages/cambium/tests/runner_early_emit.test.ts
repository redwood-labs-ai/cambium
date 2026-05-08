/**
 * RED-330: trace path discoverability for early-abort runs.
 *
 * `runGenFromIr` emits `[cambium] run <id> dir=<abs> trace=<abs>` to
 * stderr before any heavy work — so killed/OOM/early-abort runs still
 * leave a discoverable artifact path. Downstream tooling (loop drivers,
 * CI scripts) greps the line to find traces without scanning the FS.
 *
 * This test exercises the CLI subprocess (the operator-facing path) so
 * the assertion runs on real captured stderr — not a mocked process.stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red330-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function setupMinimalEngine(engineDir: string) {
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(
    join(engineDir, 'package.json'),
    JSON.stringify({ name: 'red330_engine', type: 'module', private: true }) + '\n',
  );
  writeFileSync(
    join(engineDir, 'cambium.engine.json'),
    JSON.stringify({ name: 'red330_engine', version: '0.1.0' }),
  );
  writeFileSync(
    join(engineDir, 'schemas.ts'),
    `
export const Red330Report = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: true,
  $id: 'Red330Report',
};
`.trim() + '\n',
  );
  writeFileSync(join(engineDir, 'g.system.md'), 'You are a stub.\n');
  writeFileSync(
    join(engineDir, 'g.cmb.rb'),
    `
class Red330Gen < GenModel
  model "omlx:stub"
  system :g
  returns Red330Report
  def analyze(x)
    generate "x" do
      with context: x
      returns Red330Report
    end
  end
end
`.trim() + '\n',
  );
}

describe('RED-330: early stderr emit of run dir + trace path', () => {
  it('emits `[cambium] run ... dir=... trace=...` on stderr before any heavy work', () => {
    const engineDir = join(scratch, 'engine');
    setupMinimalEngine(engineDir);
    const fixture = join(engineDir, 'fixture.txt');
    writeFileSync(fixture, 'hello\n');

    const result = spawnSync(
      'node',
      [CLI, 'run', join(engineDir, 'g.cmb.rb'), '--method', 'analyze', '--arg', fixture, '--mock'],
      { cwd: engineDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );

    // The emit line must appear on stderr.
    const stderr = result.stderr ?? '';
    const match = stderr.match(
      /\[cambium\] run (run_\S+) dir=(\S+) trace=(\S+)/,
    );
    expect(match, `stderr did not contain emit line. stderr was:\n${stderr}`).not.toBeNull();
    const [, runId, dir, trace] = match!;

    // run id, dir, and trace must be self-consistent.
    expect(dir.endsWith(runId)).toBe(true);
    expect(trace.endsWith(`${runId}/trace.json`)).toBe(true);

    // The dir must be absolute (operator-friendly: no cwd ambiguity).
    expect(dir.startsWith('/')).toBe(true);
    expect(trace.startsWith('/')).toBe(true);
  }, 30_000);

  it('the same run id appears in the emit line and in the written run artifacts', () => {
    const engineDir = join(scratch, 'engine');
    setupMinimalEngine(engineDir);
    const fixture = join(engineDir, 'fixture.txt');
    writeFileSync(fixture, 'hello\n');

    const result = spawnSync(
      'node',
      [CLI, 'run', join(engineDir, 'g.cmb.rb'), '--method', 'analyze', '--arg', fixture, '--mock'],
      { cwd: engineDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );

    const stderr = result.stderr ?? '';
    const match = stderr.match(/\[cambium\] run (run_\S+) dir=(\S+) trace=(\S+)/);
    expect(match).not.toBeNull();
    const [, runId, dir, trace] = match!;

    // The dir from the emit must exist on disk after the run.
    expect(existsSync(dir)).toBe(true);
    // The trace path from the emit must point at a real trace.json.
    expect(existsSync(trace)).toBe(true);
  }, 30_000);
});
