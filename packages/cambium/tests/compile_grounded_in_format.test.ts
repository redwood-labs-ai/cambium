/**
 * #169: `grounded_in :source, format: :markdown | :json | :text` names the
 * shape of a text source so the verifier can match a derived plain-text
 * view of it as well as the raw bytes (DEC-002).
 *
 * Two halves:
 *   - the DSL kwarg → `ir.policies.grounding.format`, absent when unset;
 *   - compile-time inference from whichever path supplied the context
 *     value, with explicit `format:` › `--arg <path>` › `from:` precedence
 *     (DEC-003).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();

function compile(
  genPath: string,
  method: string,
  extraArgs: string[] = [],
  stdin?: string,
): { ir: any | null; stderr: string } {
  const result = spawnSync(
    'ruby',
    [join(REPO_ROOT, 'ruby/cambium/compile.rb'), genPath, '--method', method, ...extraArgs],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 50 * 1024 * 1024, input: stdin },
  );
  if (result.status !== 0) {
    return { ir: null, stderr: result.stderr ?? '' };
  }
  return { ir: JSON.parse(result.stdout), stderr: result.stderr ?? '' };
}

describe('#169: grounded_in format:', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-169-'));
    mkdirSync(join(scratch, 'app/gens'), { recursive: true });
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(
      join(scratch, 'src/contracts.ts'),
      `import { Type } from '@sinclair/typebox'
export const AnalysisReport = Type.Object({}, { additionalProperties: true, $id: 'AnalysisReport' })
`,
    );
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writeGen(groundedIn: string): string {
    const path = join(scratch, 'app/gens/grounded.cmb.rb');
    writeFileSync(
      path,
      `
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  ${groundedIn}
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`.trim(),
    );
    return path;
  }

  describe('explicit kwarg', () => {
    it.each(['markdown', 'json', 'text'])('emits format: %s', (fmt) => {
      const gen = writeGen(`grounded_in :notes, require_citations: true, format: :${fmt}`);
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.policies.grounding.format).toBe(fmt);
    });

    it('leaves the key absent (not null) when format: is not declared', () => {
      writeFileSync(join(scratch, 'app/gens/notes.txt'), 'plain body');
      const gen = writeGen('grounded_in :notes, from: "notes.txt", require_citations: true');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect('format' in ir.policies.grounding).toBe(false);
      expect(ir.policies.grounding).toEqual({
        source: 'notes',
        require_citations: true,
        from: 'notes.txt',
      });
    });

    it('coexists with verify: and fields: without disturbing them', () => {
      const gen = writeGen(
        'grounded_in :invoice, verify: :field_values, fields: [:vendor, :total], format: :json',
      );
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.policies.grounding).toEqual({
        source: 'invoice',
        require_citations: false,
        verify: 'field_values',
        fields: ['vendor', 'total'],
        format: 'json',
      });
    });

    it('rejects a format outside the enum', () => {
      const gen = writeGen('grounded_in :notes, format: :yaml');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain(
        'grounded_in :notes format: must be nil or one of :markdown, :json, :text, got :yaml',
      );
    });
  });

  describe('inference from the source path (DEC-003)', () => {
    it.each([
      ['notes.md', 'markdown'],
      ['notes.markdown', 'markdown'],
      ['data.json', 'json'],
    ])('infers %s → %s from from:', (file, fmt) => {
      writeFileSync(join(scratch, `app/gens/${file}`), 'body text');
      const gen = writeGen(`grounded_in :notes, from: "${file}", require_citations: true`);
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.policies.grounding.format).toBe(fmt);
    });

    it('infers nothing from an unrecognized extension', () => {
      writeFileSync(join(scratch, 'app/gens/notes.txt'), 'body text');
      const gen = writeGen('grounded_in :notes, from: "notes.txt", require_citations: true');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect('format' in ir.policies.grounding).toBe(false);
    });

    it('--arg wins over from: — the path that supplied the value is the one that names the format', () => {
      writeFileSync(join(scratch, 'app/gens/data.json'), '{"a":1}');
      const argFixture = join(scratch, 'other.md');
      writeFileSync(argFixture, '# runtime override');
      const gen = writeGen('grounded_in :notes, from: "data.json", require_citations: true');
      const { ir, stderr } = compile(gen, 'analyze', ['--arg', argFixture]);
      expect(stderr).toBe('');
      expect(ir.context.notes).toBe('# runtime override');
      expect(ir.policies.grounding.format).toBe('markdown');
    });

    it('infers nothing from piped stdin — `--arg -` has no path', () => {
      writeFileSync(join(scratch, 'app/gens/notes.md'), '# baked in');
      const gen = writeGen('grounded_in :notes, from: "notes.md", require_citations: true');
      const { ir, stderr } = compile(gen, 'analyze', ['--arg', '-'], 'piped body');
      expect(stderr).toBe('');
      expect(ir.context.notes).toBe('piped body');
      expect('format' in ir.policies.grounding).toBe(false);
    });

    it('an empty --arg file falls through to the from: value, and infers from from:', () => {
      writeFileSync(join(scratch, 'app/gens/notes.md'), '# baked in');
      const emptyArg = join(scratch, 'empty.txt');
      writeFileSync(emptyArg, '');
      const gen = writeGen('grounded_in :notes, from: "notes.md", require_citations: true');
      const { ir, stderr } = compile(gen, 'analyze', ['--arg', emptyArg]);
      expect(stderr).toBe('');
      expect(ir.context.notes).toBe('# baked in');
      expect(ir.policies.grounding.format).toBe('markdown');
    });

    it('explicit format: :text opts out of inference', () => {
      writeFileSync(join(scratch, 'app/gens/notes.md'), '# baked in');
      const gen = writeGen('grounded_in :notes, from: "notes.md", format: :text');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.policies.grounding.format).toBe('text');
    });

    it('explicit format: wins over a conflicting extension', () => {
      writeFileSync(join(scratch, 'app/gens/notes.md'), '{"a":1}');
      const gen = writeGen('grounded_in :notes, from: "notes.md", format: :json');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.policies.grounding.format).toBe('json');
    });
  });

  describe('binary sources (DEC-011)', () => {
    const PDF_BYTES = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\n%%EOF\n',
      'binary',
    );

    it('refuses an explicit format: on a from: that resolved to an envelope', () => {
      writeFileSync(join(scratch, 'app/gens/report.pdf'), PDF_BYTES);
      const gen = writeGen('grounded_in :doc, from: "report.pdf", format: :markdown');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain(
        'grounded_in :doc format: "markdown" applies to text sources, but from: "report.pdf" '
        + 'resolved to a base64_pdf envelope. Drop format: or point from: at a text file.',
      );
    });

    it('allows an explicit format: when --arg overrides the envelope (A-005)', () => {
      // The envelope never reaches ir.context, so `format: :json` describes
      // exactly the value that ships. Refusing this would reject a compile
      // that `--arg` already made coherent.
      writeFileSync(join(scratch, 'app/gens/report.pdf'), PDF_BYTES);
      const argFixture = join(scratch, 'other.json');
      writeFileSync(argFixture, '{"status":"degraded"}');
      const gen = writeGen('grounded_in :doc, from: "report.pdf", format: :json');
      const { ir, stderr } = compile(gen, 'analyze', ['--arg', argFixture]);
      expect(stderr).toBe('');
      expect(ir.context.doc).toBe('{"status":"degraded"}');
      expect(ir.policies.grounding.format).toBe('json');
    });

    it('still refuses the same gen when no --arg supplies text (A-005)', () => {
      writeFileSync(join(scratch, 'app/gens/report.pdf'), PDF_BYTES);
      const gen = writeGen('grounded_in :doc, from: "report.pdf", format: :json');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain(
        'grounded_in :doc format: "json" applies to text sources, but from: "report.pdf" '
        + 'resolved to a base64_pdf envelope. Drop format: or point from: at a text file.',
      );
    });

    it('leaves a format-less binary from: exactly as it was', () => {
      writeFileSync(join(scratch, 'app/gens/report.pdf'), PDF_BYTES);
      const gen = writeGen('grounded_in :doc, from: "report.pdf"');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.context.doc).toEqual({
        kind: 'base64_pdf',
        data: PDF_BYTES.toString('base64'),
        media_type: 'application/pdf',
      });
      expect('format' in ir.policies.grounding).toBe(false);
    });
  });
});
