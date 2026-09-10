/**
 * #201: MenuEntry post-Generate tail, driven end-to-end through the real
 * runner via `cambium replay --edit` (RED-312) — same technique as the
 * `theme_palette` precedent's DEC-200-009 (records/PLAN-200
 * -themepalette-2026-09-01.md), used here for the same reason: this
 * test needs EXACT, hand-controlled candidates (a clean single-field
 * entry; a schema-valid entry that sets both `action` and `target`) to
 * exercise specific corrector paths deterministically, which a plain
 * `cambium run --mock` cannot steer.
 *
 * Two scenarios:
 *
 *  1. A healthy candidate — `id`/`label`/`action` only, no `target` —
 *     merges into the fixture overlay, parses clean through the real
 *     vendored `MenuModel.js` with kind="action", and clears with NO
 *     Repair. This is the ticket's first acceptance bullet: "Fixture
 *     request → entry whose merged overlay parses clean through the
 *     real MenuModel.js with the intended kind."
 *
 *  2. An ambiguous candidate — BOTH `action` and `target` set — proves
 *     `menu_model_check`'s error-severity issue genuinely feeds Repair
 *     (the trace shows it), the ticket's second acceptance bullet. As
 *     with `theme_palette` (#200) under `--mock`, repair's own mock
 *     reply is schema-derived placeholder text with both fields set
 *     again, so the run ends in `CorrectAcceptedWithErrors` rather than
 *     a completed heal — the loop firing is what's proven here; see
 *     `menu_entry.test.ts`'s golden for the same honest framing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const GEN = 'packages/cambium/app/gens/menu_entry.cmb.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/menu_entry_request.json';

const HEALTHY_CANDIDATE = {
  id: 'obsidian-notes',
  label: 'Notes (Obsidian)',
  action: 'obsidian ~/notes',
};

// Schema-valid but ambiguous: both action and target set. Omarchy's real
// parser infers kind="action" (action wins the priority order) and
// silently drops the target's behavior.
const AMBIGUOUS_CANDIDATE = {
  id: 'obsidian-notes',
  label: 'Notes (Obsidian)',
  action: 'obsidian ~/notes',
  target: 'obsidian://open?vault=notes',
};

function firstRunId(stderr: string): string {
  const m = stderr.match(/\[cambium\] run (run_\S+)/);
  if (!m) throw new Error(`no run id in stderr:\n${stderr}`);
  return m[1];
}

function editorScript(scratch: string, name: string, candidate: object): string {
  const path = join(scratch, name);
  const payload = JSON.stringify(candidate).replace(/'/g, `'\\''`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${payload}' > "$1"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('#201: MenuEntry post-Generate tail via replay (mock)', () => {
  let scratch: string;
  let baseRunId: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-menu-entry-replay-'));

    // A base run to replay from. Like theme_palette's equivalent test,
    // this first `--mock` run may itself already fail the corrector
    // (see menu_entry.test.ts) — irrelevant here, since only its run
    // dir (ir.json + output.json) is needed as `--edit`'s starting
    // point; `--edit` overwrites the candidate wholesale.
    const run = spawnSync(
      'node',
      [CLI, 'run', GEN, '--method', 'propose_entry', '--arg', FIXTURE, '--mock'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    baseRunId = firstRunId(run.stderr);
    cleanup.push(baseRunId);
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    for (const id of cleanup) {
      const dir = join('runs', id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a healthy candidate (action only) clears the tail clean: real parser gives kind=action, no Repair', () => {
    const editor = editorScript(scratch, 'healthy-editor.sh', HEALTHY_CANDIDATE);
    const traceOut = join(scratch, 'healthy-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', baseRunId, '--edit', '--mock', '--trace', traceOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, EDITOR: editor } },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);
    if (replay.status !== 0) {
      throw new Error(`replay exited ${replay.status}\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');
    expect(types).not.toContain('Repair');
    expect(trace.final?.ok).toBe(true);

    const correct = trace.steps.find((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('menu_model_check'));
    expect(correct?.meta?.issues).toEqual([]);

    const output = JSON.parse(readFileSync(join('runs', replayId!, 'output.json'), 'utf8'));
    expect(output).toEqual(HEALTHY_CANDIDATE);
  });

  it('an ambiguous candidate (both action and target) triggers menu_model_check errors that feed Repair (trace shows the loop)', () => {
    const editor = editorScript(scratch, 'ambiguous-editor.sh', AMBIGUOUS_CANDIDATE);
    const traceOut = join(scratch, 'ambiguous-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', baseRunId, '--edit', '--mock', '--trace', traceOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, EDITOR: editor } },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);
    if (!existsSync(traceOut)) {
      throw new Error(`no trace written\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');

    // The initial Correct step recorded the ambiguous-kind error...
    const correct = trace.steps.find((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('menu_model_check'));
    const errorIssues = (correct?.meta?.issues ?? []).filter((i: any) => i.severity === 'error');
    expect(errorIssues).toHaveLength(1);
    expect(errorIssues[0].path).toBe('action,target');
    expect(errorIssues[0].message).toMatch(/kind="action"/);

    // ...and that error-severity issue fed Repair — the ticket's second
    // acceptance bullet ("is caught by the corrector and repaired — the
    // trace shows it").
    expect(types).toContain('Repair');

    // Same honest DEC-200-009-style outcome as theme_palette: repair's
    // mock reply is equally placeholder-shaped (both fields set again),
    // so `CorrectAfterRepair` re-flags the same ambiguity and the run
    // ends in the RED-298 graceful-degrade step rather than a
    // completed heal.
    const accepted = trace.steps.find((s: any) => s.type === 'CorrectAcceptedWithErrors');
    expect(accepted).toBeDefined();
    expect(accepted.meta?.corrector).toBe('menu_model_check');
  });
});
