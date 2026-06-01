/**
 * RED-312 / RED-385: gen-level `cambium replay` end-to-end through the
 * repair loop. The card's acceptance scenario:
 *
 *   run a gen → replay --edit with an edited candidate that fails schema →
 *   the repair loop fires and heals it → replay succeeds, output schema-valid.
 *
 * Driven through the real CLI (spawn) against the mock provider. `--edit`
 * is exercised via a non-interactive $EDITOR script that overwrites the
 * candidate with `{}` (valid JSON, fails AnalysisReport's required fields),
 * forcing Validate → Repair → ValidateAfterRepair. Deterministic: the
 * corruption is fixed and mock-repair regenerates a valid AnalysisReport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const GEN = 'packages/cambium/app/gens/analyst.cmb.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt';

function firstRunId(stderr: string): string {
  const m = stderr.match(/\[cambium\] run (run_\S+)/);
  if (!m) throw new Error(`no run id in stderr:\n${stderr}`);
  return m[1];
}

describe('RED-312: gen replay through the repair loop (mock, end-to-end)', () => {
  let scratch: string;
  let editor: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-replay-repair-'));
    // $EDITOR that corrupts the candidate to `{}` non-interactively.
    editor = join(scratch, 'corrupt-editor.sh');
    writeFileSync(editor, '#!/bin/sh\nprintf \'{}\' > "$1"\n');
    chmodSync(editor, 0o755);
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    for (const id of cleanup) {
      const dir = join('runs', id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replay --edit on a candidate that fails schema fires Repair and heals it', () => {
    // 1. A clean run produces a valid output.json under <cwd>/runs/<id>.
    const run = spawnSync(
      'node',
      [CLI, 'run', GEN, '--method', 'analyze', '--arg', FIXTURE, '--mock'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    expect(run.status).toBe(0);
    const runId = firstRunId(run.stderr);
    cleanup.push(runId);

    // 2. Replay, corrupting the candidate via --edit; --mock lets the
    //    repair step regenerate a valid AnalysisReport.
    const traceOut = join(scratch, 'replay-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', runId, '--edit', '--mock', '--trace', traceOut],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, EDITOR: editor, CAMBIUM_ALLOW_MOCK: '1' },
      },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);

    if (replay.status !== 0) {
      throw new Error(`replay exited ${replay.status}\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);

    // Generate was skipped; the corrupted candidate failed validation; the
    // repair loop fired and the re-validation passed.
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');
    expect(types).toContain('Repair');
    expect(types).toContain('ValidateAfterRepair');

    const firstValidate = trace.steps.find((s: any) => s.type === 'Validate');
    expect(firstValidate?.ok).toBe(false); // the {} candidate failed required-field checks
    const afterRepair = trace.steps.find((s: any) => s.type === 'ValidateAfterRepair');
    expect(afterRepair?.ok).toBe(true); // repair healed it

    // Run succeeded with a schema-valid output, and lineage is recorded.
    expect(trace.final?.ok).toBe(true);
    expect(trace.parent_run_id).toBe(runId);

    const replayDir = join('runs', replayId!);
    const output = JSON.parse(readFileSync(join(replayDir, 'output.json'), 'utf8'));
    expect(typeof output.summary).toBe('string');
    expect(output.summary.length).toBeGreaterThan(0);
  });
});
