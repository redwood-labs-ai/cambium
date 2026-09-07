/** #224: regression coverage for the shared run-dir helpers.
 *
 *  The whitespace case is the reason this module exists — `dir=(\S+)`
 *  truncated at the first space, so a checkout under a path containing
 *  whitespace produced an ENOENT naming a directory that never existed,
 *  and the failure read as a product bug rather than a harness bug.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunDir, tryReadRunDir, cleanupRunDir } from './run-dir.js';

const emit = (dir: string, trace: string, suffix = '') =>
  `[cambium] run run_123 dir=${dir}${suffix} trace=${trace}${suffix}\n`;

describe('#224 readRunDir / tryReadRunDir', () => {
  it('parses a plain path', () => {
    const s = emit('/repo/runs/run_1', '/repo/runs/run_1/trace.json');
    expect(readRunDir(s)).toBe('/repo/runs/run_1');
  });

  it('parses a path containing whitespace (the bug this fixes)', () => {
    const dir = '/Users/x/My Projects/cambium/runs/run_1';
    const s = emit(dir, `${dir}/trace.json`);
    expect(readRunDir(s)).toBe(dir);
    // The old pattern truncated here — guard against a regression to it.
    expect(s.match(/dir=(\S+)/)![1]).toBe('/Users/x/My');
  });

  it('strips the "(not yet created)" suffix rather than capturing it', () => {
    const dir = '/repo/runs/run_1';
    const s = emit(dir, `${dir}/trace.json`, ' (not yet created)');
    expect(readRunDir(s)).toBe(dir);
  });

  it('handles whitespace path AND the not-yet-created suffix together', () => {
    const dir = '/My Projects/runs/run_1';
    const s = emit(dir, `${dir}/trace.json`, ' (not yet created)');
    expect(readRunDir(s)).toBe(dir);
  });

  it('is unconfused by a --trace override that itself contains spaces', () => {
    const s = emit('/repo/runs/run_1', '/tmp/custom trace.json');
    expect(readRunDir(s)).toBe('/repo/runs/run_1');
  });

  it('tryReadRunDir returns undefined instead of throwing when there is no emit', () => {
    expect(tryReadRunDir('some unrelated stderr\n')).toBeUndefined();
  });

  it('picks the first emit when a pipeline run nests sub-gen emits', () => {
    const s =
      emit('/repo/runs/outer', '/repo/runs/outer/trace.json') +
      emit('/repo/runs/inner', '/repo/runs/inner/trace.json');
    expect(readRunDir(s)).toBe('/repo/runs/outer');
  });
});

describe('#224 cleanupRunDir', () => {
  it('removes the directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'cambium-224-'));
    const dir = join(base, 'run_1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trace.json'), '{}');
    cleanupRunDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('tolerates undefined so it can sit in a finally with no guard', () => {
    expect(() => cleanupRunDir(undefined)).not.toThrow();
  });

  it('preserves the directory under CAMBIUM_KEEP_TEST_RUNS=1', () => {
    const base = mkdtempSync(join(tmpdir(), 'cambium-224-keep-'));
    const dir = join(base, 'run_1');
    mkdirSync(dir, { recursive: true });
    const prev = process.env.CAMBIUM_KEEP_TEST_RUNS;
    process.env.CAMBIUM_KEEP_TEST_RUNS = '1';
    try {
      cleanupRunDir(dir);
      expect(existsSync(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CAMBIUM_KEEP_TEST_RUNS;
      else process.env.CAMBIUM_KEEP_TEST_RUNS = prev;
    }
  });
});
