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

  // ── #195: precompiled catalog resolution ───────────────────────────

  function writeIr(relPath: string, body = '{"analyze":{"version":"0.2"}}') {
    const abs = join(tmp, relPath);
    const dir = abs.substring(0, abs.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, body);
  }

  describe('#195 precompiled: { precompiled: true } — sibling artifact resolution', () => {
    it('resolves each gen entry to its sibling .ir.json without requiring the .cmb.rb to exist', () => {
      writeGenfile(`
[exports.gens]
ResumeParser = "app/gens/resume_parser.cmb.rb"
`);
      writeIr('app/gens/resume_parser.ir.json');
      const catalog = loadGenCatalog(tmp, { precompiled: true });
      const entry = catalog.entries.get('ResumeParser')!;
      expect(entry.irPath).toBe(join(tmp, 'app/gens/resume_parser.ir.json'));
      // The declared .cmb.rb need not exist on disk in precompiled mode.
      expect(entry.genFilePath).toBe(join(tmp, 'app/gens/resume_parser.cmb.rb'));
    });

    it('a .cmb.rb catalog value that DOES exist still resolves to the sibling artifact', () => {
      writeGen('app/gens/foo.cmb.rb');
      writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"
`);
      writeIr('app/gens/foo.ir.json');
      const catalog = loadGenCatalog(tmp, { precompiled: true });
      expect(catalog.entries.get('Foo')!.irPath).toBe(join(tmp, 'app/gens/foo.ir.json'));
    });

    it('a `.ir.json` catalog value is still rejected — the catalog names gens, not files', () => {
      writeGenfile(`
[exports.gens]
Bad = "app/gens/foo.ir.json"
`);
      expect(() => loadGenCatalog(tmp, { precompiled: true })).toThrow(/must end.*\.cmb\.rb/);
    });

    it('lists ALL missing artifacts in a single error, not just the first', () => {
      writeGenfile(`
[exports.gens]
ResumeParser = "app/gens/resume_parser.cmb.rb"
CandidateSummary = "app/gens/candidate_summary.cmb.rb"
`);
      // Neither artifact written.
      let thrown: Error | undefined;
      try {
        loadGenCatalog(tmp, { precompiled: true });
      } catch (e: any) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toMatch(/ResumeParser/);
      expect(thrown!.message).toMatch(/CandidateSummary/);
      expect(thrown!.message).toMatch(/resume_parser\.ir\.json/);
      expect(thrown!.message).toMatch(/candidate_summary\.ir\.json/);
    });

    it('refuses [exports.pipelines] entries with the DEC-001 wording', () => {
      writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"

[exports.pipelines]
MyPipeline = "app/pipelines/my_pipeline.pipeline.rb"
`);
      writeIr('app/gens/foo.ir.json');
      expect(() => loadGenCatalog(tmp, { precompiled: true })).toThrow(
        /\[exports\.pipelines\].*MyPipeline.*need Ruby at run time \(pipeline\)/s,
      );
    });

    it('a zero-arg call is byte-identical to before #195 (no precompiled resolution)', () => {
      writeGen('app/gens/foo.cmb.rb');
      writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"
`);
      const catalog = loadGenCatalog(tmp);
      expect(catalog.entries.get('Foo')).toEqual({
        name: 'Foo',
        genFilePath: join(tmp, 'app/gens/foo.cmb.rb'),
        kind: 'gen',
      });
    });
  });

  describe('#195 precompiled: { irDir } — flat-by-basename resolution', () => {
    it('resolves each gen entry to <irDir>/<basename>.ir.json, implying precompiled', () => {
      writeGenfile(`
[exports.gens]
ResumeParser = "app/gens/resume_parser.cmb.rb"
`);
      const irDir = join(tmp, 'dist/ir');
      mkdirSync(irDir, { recursive: true });
      writeFileSync(join(irDir, 'resume_parser.ir.json'), '{"analyze":{"version":"0.2"}}');
      const catalog = loadGenCatalog(tmp, { irDir });
      expect(catalog.entries.get('ResumeParser')!.irPath).toBe(join(irDir, 'resume_parser.ir.json'));
    });

    it('irDir wins when both precompiled and irDir are set', () => {
      writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"
`);
      // Sibling artifact deliberately absent — only the irDir copy exists.
      const irDir = join(tmp, 'dist/ir');
      mkdirSync(irDir, { recursive: true });
      writeFileSync(join(irDir, 'foo.ir.json'), '{"analyze":{"version":"0.2"}}');
      const catalog = loadGenCatalog(tmp, { precompiled: true, irDir });
      expect(catalog.entries.get('Foo')!.irPath).toBe(join(irDir, 'foo.ir.json'));
    });

    it('missing artifact under irDir fails boot with the irDir path', () => {
      writeGenfile(`
[exports.gens]
Foo = "app/gens/foo.cmb.rb"
`);
      const irDir = join(tmp, 'dist/ir');
      expect(() => loadGenCatalog(tmp, { irDir })).toThrow(/Foo.*dist\/ir\/foo\.ir\.json/s);
    });
  });
});
