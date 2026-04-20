import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveGenfileContracts,
  loadContractsFromGenfile,
} from './genfile.js';

describe('resolveGenfileContracts (RED-274)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-genfile-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when no Genfile.toml exists', () => {
    expect(resolveGenfileContracts(tmp)).toBeNull();
  });

  it('returns null for a workspace-style Genfile with no [types]', () => {
    writeFileSync(join(tmp, 'Genfile.toml'), '[workspace]\nmembers = ["packages/*"]\n');
    expect(resolveGenfileContracts(tmp)).toBeNull();
  });

  it('returns null for a package Genfile without [types].contracts', () => {
    writeFileSync(join(tmp, 'Genfile.toml'), '[package]\nname = "x"\n');
    expect(resolveGenfileContracts(tmp)).toBeNull();
  });

  it('resolves a single contracts path relative to the Genfile directory', () => {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'contracts.ts'), 'export const X = {};\n');
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[package]\nname = "x"\n\n[types]\ncontracts = ["src/contracts.ts"]\n',
    );
    const res = resolveGenfileContracts(tmp);
    expect(res).not.toBeNull();
    expect(res!.contractsPaths).toEqual([join(tmp, 'src', 'contracts.ts')]);
    expect(res!.genfileDir).toBe(tmp);
  });

  it('resolves multiple contracts paths in declaration order', () => {
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src', 'a.ts'), 'export const A = {};\n');
    writeFileSync(join(tmp, 'src', 'b.ts'), 'export const B = {};\n');
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["src/a.ts", "src/b.ts"]\n',
    );
    const res = resolveGenfileContracts(tmp);
    expect(res!.contractsPaths).toEqual([
      join(tmp, 'src', 'a.ts'),
      join(tmp, 'src', 'b.ts'),
    ]);
  });

  it('rejects a path that escapes the Genfile directory', () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["../../etc/passwd"]\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(
      /resolves outside the Genfile directory/,
    );
  });

  it('rejects an absolute path', () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["/etc/passwd"]\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(
      /must be relative to the Genfile directory/,
    );
  });

  it('rejects a path containing a null byte (via TOML \\u0000 escape)', () => {
    // A raw null byte in the source is rejected by smol-toml itself
    // (TOML forbids control chars in strings). The `\u0000` escape is
    // valid TOML syntax and produces a null char at parse time — our
    // own guard catches it before path.resolve sees it.
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["src/contracts\\u0000evil"]\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(/null byte/);
  });

  it('rejects non-string entries', () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = [42]\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(
      /entries must be strings/,
    );
  });

  it('rejects a non-array contracts value', () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = "src/contracts.ts"\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(
      /must be an array of strings/,
    );
  });

  it('errors when a declared contracts file does not exist', () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["src/missing.ts"]\n',
    );
    expect(() => resolveGenfileContracts(tmp)).toThrow(
      /does not exist: src\/missing\.ts/,
    );
  });

  it('errors cleanly on malformed TOML (names the Genfile)', () => {
    writeFileSync(join(tmp, 'Genfile.toml'), '[types\ncontracts = [');
    expect(() => resolveGenfileContracts(tmp)).toThrow(/Genfile parse error/);
  });

  it('treats an empty contracts list as no declaration', () => {
    writeFileSync(join(tmp, 'Genfile.toml'), '[types]\ncontracts = []\n');
    expect(resolveGenfileContracts(tmp)).toBeNull();
  });
});

describe('loadContractsFromGenfile (RED-274)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-genfile-load-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('imports named exports and merges across multiple files', async () => {
    writeFileSync(
      join(tmp, 'a.mjs'),
      'export const Alpha = { $id: "Alpha" };\n',
    );
    writeFileSync(
      join(tmp, 'b.mjs'),
      'export const Beta = { $id: "Beta" };\nexport default { shouldBe: "skipped" };\n',
    );
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["a.mjs", "b.mjs"]\n',
    );
    const res = resolveGenfileContracts(tmp);
    const merged = await loadContractsFromGenfile(res!);
    expect(merged.Alpha).toEqual({ $id: 'Alpha' });
    expect(merged.Beta).toEqual({ $id: 'Beta' });
    expect(merged.default).toBeUndefined();
  });

  it('refuses a non-absolute path in the resolution (sanity rail)', async () => {
    const bogus: any = { genfileDir: tmp, contractsPaths: ['./a.mjs'], genfilePath: join(tmp, 'Genfile.toml') };
    await expect(loadContractsFromGenfile(bogus)).rejects.toThrow(/not absolute/);
  });

  it('later files override earlier files on name collision', async () => {
    writeFileSync(join(tmp, 'a.mjs'), 'export const X = { from: "a" };\n');
    writeFileSync(join(tmp, 'b.mjs'), 'export const X = { from: "b" };\n');
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      '[types]\ncontracts = ["a.mjs", "b.mjs"]\n',
    );
    const res = resolveGenfileContracts(tmp);
    const merged = await loadContractsFromGenfile(res!);
    expect(merged.X).toEqual({ from: 'b' });
  });
});
