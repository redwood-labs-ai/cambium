import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRuns, loadRun, isValidRunId, resolveRunsDir } from './runs.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const genTrace = readFileSync(join(FX, 'gen-linear.trace.json'), 'utf8');

let root: string;
let runsDir: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cambium-runs-'));
  runsDir = join(root, 'runs');
  outside = join(root, 'outside');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  // a normal run
  mkdirSync(join(runsDir, 'run_normal_aaaa'));
  writeFileSync(join(runsDir, 'run_normal_aaaa', 'trace.json'), genTrace);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('isValidRunId', () => {
  it('accepts runner-shaped ids, rejects traversal/odd ids', () => {
    expect(isValidRunId('run_20260101_000000_abc123')).toBe(true);
    expect(isValidRunId('run_20260101T000000Z_abc')).toBe(true);
    expect(isValidRunId('../etc/passwd')).toBe(false);
    expect(isValidRunId('run_../x')).toBe(false);
    expect(isValidRunId('notarun')).toBe(false);
    expect(isValidRunId('run_' + 'a'.repeat(200))).toBe(false);
  });
});

describe('resolveRunsDir', () => {
  it('defaults to <cwd>/runs and honors an explicit override', () => {
    expect(resolveRunsDir('/ws')).toMatch(/runs$/);
    expect(resolveRunsDir('/ws', '/custom/runs')).toBe('/custom/runs');
  });
});

describe('symlink escape guard (listRuns + loadRun symmetry)', () => {
  beforeEach(() => {
    // a run dir that is a symlink pointing OUTSIDE runsDir, with a valid trace.
    writeFileSync(join(outside, 'trace.json'), genTrace);
    try {
      symlinkSync(outside, join(runsDir, 'run_evil_link'), 'dir');
    } catch {
      /* symlink may be unsupported on some CI; the assertions below still hold
         (the entry simply won't exist). */
    }
  });

  it('listRuns skips a run dir that symlinks outside runsDir', () => {
    const ids = listRuns(runsDir).map((r) => r.id);
    expect(ids).toContain('run_normal_aaaa');
    expect(ids).not.toContain('run_evil_link');
  });

  it('loadRun refuses a symlinked-escape id but loads a normal run', () => {
    expect(loadRun(runsDir, 'run_evil_link')).toBeNull();
    expect(loadRun(runsDir, 'run_normal_aaaa')?.model.kind).toBe('gen');
  });

  it('loadRun refuses an invalid id without touching the fs', () => {
    expect(loadRun(runsDir, '../../etc')).toBeNull();
  });
});
