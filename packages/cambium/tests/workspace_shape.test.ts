/**
 * RED-286: Genfile-shape detection helper tests.
 *
 * `detectWorkspaceShape` is the shared anchor-resolution function used
 * by the CLI scaffolders, lint, and the VS Code extension. A mis-detect
 * here silently misroutes scaffolded files — these tests pin the four
 * canonical inputs (workspace / package / legacy-fallback / nothing)
 * plus the error paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectWorkspaceShape } from '../../../cli/workspace-shape.mjs';

let scratch: string;
beforeEach(() => {
  // realpath so macOS /var vs /private/var doesn't break equality checks.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-shape-')));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe('detectWorkspaceShape', () => {
  it('returns workspace shape when Genfile has [workspace]', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n`,
    );
    const shape = detectWorkspaceShape(scratch);
    expect(shape).toEqual({
      workspaceRoot: scratch,
      shape: 'workspace',
      appPkgRoot: join(scratch, 'packages', 'cambium'),
    });
  });

  it('returns package shape when Genfile has [package]', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[package]\nname = "curator"\nversion = "0.1.0"\n`,
    );
    const shape = detectWorkspaceShape(scratch);
    expect(shape).toEqual({
      workspaceRoot: scratch,
      shape: 'package',
      appPkgRoot: scratch,
    });
  });

  it('prefers [workspace] when both sections are present', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n\n[package]\nname = "also_a_pkg"\nversion = "0.1.0"\n`,
    );
    const shape = detectWorkspaceShape(scratch);
    expect(shape?.shape).toBe('workspace');
  });

  it('returns workspace shape via legacy packages/cambium/ fallback when no Genfile', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const shape = detectWorkspaceShape(scratch);
    expect(shape).toEqual({
      workspaceRoot: scratch,
      shape: 'workspace',
      appPkgRoot: join(scratch, 'packages', 'cambium'),
    });
  });

  it('walks up to find a workspace Genfile from a nested directory', () => {
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n`,
    );
    const deep = join(scratch, 'packages', 'foo', 'bar');
    mkdirSync(deep, { recursive: true });
    const shape = detectWorkspaceShape(deep);
    expect(shape?.workspaceRoot).toBe(scratch);
    expect(shape?.shape).toBe('workspace');
  });

  it('stops at the FIRST Genfile going up — inner package Genfile wins over outer workspace', () => {
    // Layout: scratch/Genfile.toml (workspace) + scratch/packages/cambium/Genfile.toml (package).
    // Walking up from scratch/packages/cambium/app/ should stop at the PACKAGE Genfile
    // — that's the correct anchor for scaffolding into that package directly.
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*"]\n`,
    );
    const pkg = join(scratch, 'packages', 'cambium');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "cambium"\nversion = "0.1.0"\n`,
    );
    const appDir = join(pkg, 'app');
    mkdirSync(appDir, { recursive: true });

    const shape = detectWorkspaceShape(appDir);
    expect(shape?.workspaceRoot).toBe(pkg);
    expect(shape?.shape).toBe('package');
    expect(shape?.appPkgRoot).toBe(pkg);
  });

  it('returns null when no Genfile and no packages/cambium/ exist up to fs root', () => {
    // A freshly-mkdtemp'd scratch dir lives under /tmp or /var/folders/...
    // — no Cambium markers on the way up, so null is the expected result.
    const shape = detectWorkspaceShape(scratch);
    expect(shape).toBeNull();
  });

  it('throws on a Genfile with neither [workspace] nor [package]', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `# empty genfile\n`);
    expect(() => detectWorkspaceShape(scratch)).toThrow(/neither \[workspace\] nor \[package\]/);
  });

  it('throws on a malformed Genfile (invalid TOML)', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `this is [not valid toml\n`);
    expect(() => detectWorkspaceShape(scratch)).toThrow(/Genfile parse error/);
  });
});
