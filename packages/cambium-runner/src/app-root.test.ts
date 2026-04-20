/**
 * RED-286: runtime app-package-root resolution tests.
 *
 * `resolveAppRoot` decides where `app/tools/` and `app/actions/` live
 * for runtime dispatch. A mis-detect silently points at a
 * non-existent directory, so tools go "missing" with no error. These
 * tests pin the four canonical cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAppRoot } from './app-root.js';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-approot-')));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe('resolveAppRoot', () => {
  it('returns <root>/packages/cambium for a [workspace] Genfile', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n`,
    );
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('workspace');
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'cambium'));
  });

  it('returns <root> for a [package] Genfile (flat external app)', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[package]\nname = "curator"\nversion = "0.1.0"\n`,
    );
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('package');
    expect(r.appPkgRoot).toBe(scratch);
  });

  it('uses the legacy packages/cambium/ fallback when no Genfile exists', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('workspace');
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'cambium'));
  });

  it('walks up to find the workspace anchor from a nested cwd', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n`,
    );
    const deep = join(scratch, 'packages', 'cambium', 'src');
    mkdirSync(deep, { recursive: true });
    const r = resolveAppRoot(deep);
    // Walking up from packages/cambium/src hits packages/cambium first
    // — no Genfile there, but the packages/cambium/-subdir fallback
    // doesn't apply (that path is the cwd's DIR, not a subdir). Walk
    // continues up, finds the workspace Genfile at scratch.
    //
    // Wait — packages/cambium IS the cwd here. The fallback check is
    // `existsSync(join(dir, 'packages', 'cambium'))`. At dir =
    // packages/cambium, that's packages/cambium/packages/cambium —
    // nope. At dir = scratch, packages/cambium exists, but scratch
    // also has the Genfile, which wins.
    expect(r.shape).toBe('workspace');
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'cambium'));
  });

  it('legacy default (no Genfile, no packages/cambium/ anywhere) returns shape: none', () => {
    // An orphan scratch dir with no Cambium markers. The function
    // returns a best-effort legacy path so pre-RED-286 call sites
    // that spawn without a Genfile keep working.
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('none');
    expect(r.appPkgRoot).toBe(join(scratch, 'packages', 'cambium'));
  });

  it('prefers [workspace] when both sections are in the Genfile', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n\n[package]\nname = "also"\nversion = "0.1.0"\n`,
    );
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('workspace');
  });

  it('malformed Genfile (neither section) falls through to legacy default', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `# empty\n`);
    const r = resolveAppRoot(scratch);
    expect(r.shape).toBe('none');
  });
});
