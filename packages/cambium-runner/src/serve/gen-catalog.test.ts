import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGenCatalog } from './gen-catalog.js';

describe('loadGenCatalog (RED-360)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-gen-catalog-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeGenfile(toml: string) {
    writeFileSync(join(tmp, 'Genfile.toml'), toml);
  }

  function writeGen(relPath: string) {
    const abs = join(tmp, relPath);
    const dir = abs.substring(0, abs.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, '# stub gen file\n');
  }

  it('happy path: loads a multi-gen catalog and resolves paths to absolute', () => {
    writeGen('app/gens/resume_parser.cmb.rb');
    writeGen('app/gens/candidate_summary.cmb.rb');
    writeGenfile(`
[package]
name = "test-app"

[exports.gens]
ResumeParser = "app/gens/resume_parser.cmb.rb"
CandidateSummary = "app/gens/candidate_summary.cmb.rb"
`);
    const catalog = loadGenCatalog(tmp);
    expect(catalog.workspaceDir).toBe(tmp);
    expect(catalog.entries.size).toBe(2);
    expect(catalog.entries.get('ResumeParser')).toEqual({
      name: 'ResumeParser',
      genFilePath: join(tmp, 'app/gens/resume_parser.cmb.rb'),
      kind: 'gen',
    });
    expect(catalog.entries.get('CandidateSummary')).toEqual({
      name: 'CandidateSummary',
      genFilePath: join(tmp, 'app/gens/candidate_summary.cmb.rb'),
      kind: 'gen',
    });
  });

  it('preserves PascalCase + underscores in export keys', () => {
    writeGen('app/gens/multi_word.cmb.rb');
    writeGenfile(`
[exports.gens]
Multi_Word_Gen = "app/gens/multi_word.cmb.rb"
`);
    const catalog = loadGenCatalog(tmp);
    expect(catalog.entries.has('Multi_Word_Gen')).toBe(true);
  });

  it('throws when --workspace lacks Genfile.toml', () => {
    expect(() => loadGenCatalog(tmp))
      .toThrow(/no Genfile\.toml at .*\/Genfile\.toml/);
  });

  it('throws on malformed TOML', () => {
    writeGenfile('this is not [valid TOML');
    expect(() => loadGenCatalog(tmp)).toThrow(/failed to parse/);
  });

  it('throws when both [exports.gens] and [exports.pipelines] are missing', () => {
    writeGenfile(`
[package]
name = "test-app"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(
      /neither \[exports\.gens\] nor \[exports\.pipelines\]/,
    );
  });

  it('throws when both sections exist but are empty', () => {
    writeGenfile(`
[exports.gens]

[exports.pipelines]
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/declares no entries/);
  });

  it('throws when an entry is not a string', () => {
    writeGenfile(`
[exports.gens]
BadEntry = 42
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/must be a string path/);
  });

  it('throws when an entry is an empty string', () => {
    writeGenfile(`
[exports.gens]
Empty = ""
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/is an empty string/);
  });

  it('throws on absolute path entries', () => {
    writeGen('app/gens/foo.cmb.rb');
    writeGenfile(`
[exports.gens]
Absolute = "/etc/passwd"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/must be relative to the workspace/);
  });

  it('throws on path-traversal escapes (..)', () => {
    writeGen('app/gens/foo.cmb.rb');
    writeGenfile(`
[exports.gens]
Escape = "../outside.cmb.rb"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/resolves outside the workspace/);
  });

  it('throws when the declared file does not exist', () => {
    writeGenfile(`
[exports.gens]
Missing = "app/gens/nonexistent.cmb.rb"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/file does not exist/);
  });

  it('rejects lowercase export keys', () => {
    writeGen('app/gens/lower.cmb.rb');
    writeGenfile(`
[exports.gens]
lowercase = "app/gens/lower.cmb.rb"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/not a valid export name/);
  });

  it('rejects export keys starting with digits', () => {
    writeGen('app/gens/digit.cmb.rb');
    writeGenfile(`
[exports.gens]
"1Gen" = "app/gens/digit.cmb.rb"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/not a valid export name/);
  });

  it('rejects export keys with hyphens or other punctuation', () => {
    writeGen('app/gens/hyphen.cmb.rb');
    writeGenfile(`
[exports.gens]
"My-Gen" = "app/gens/hyphen.cmb.rb"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/not a valid export name/);
  });

  it('throws when [exports.gens] is an array, not a table', () => {
    writeGenfile(`
[[exports.gens]]
name = "ResumeParser"
`);
    expect(() => loadGenCatalog(tmp)).toThrow(/must be a TOML table/);
  });

  it('handles a workspace whose path needs normalization (trailing slash, etc.)', () => {
    writeGen('app/gens/foo.cmb.rb');
    writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"
`);
    // Pass with a trailing slash; resolve() should normalize.
    const catalog = loadGenCatalog(tmp + '/');
    expect(catalog.workspaceDir).toBe(tmp);
    expect(catalog.entries.get('Foo')!.genFilePath).toBe(
      join(tmp, 'app/gens/foo.cmb.rb'),
    );
  });

  it('regression: paths inside the workspace but with .. segments mid-path are still validated', () => {
    // app/gens/../gens/foo.cmb.rb → app/gens/foo.cmb.rb after resolve.
    // The relative() check is what catches escapes, not a string scan.
    writeGen('app/gens/foo.cmb.rb');
    writeGenfile(`
[exports.gens]
Quirky = "app/gens/../gens/foo.cmb.rb"
`);
    const catalog = loadGenCatalog(tmp);
    expect(catalog.entries.get('Quirky')!.genFilePath).toBe(
      join(tmp, 'app/gens/foo.cmb.rb'),
    );
  });
});
