/**
 * RED-383 (minimum cut): `grounded_in :source, from: "<path>"` resolves
 * the file at compile time and stamps the contents into ir.context.<source>.
 *
 * Scope of this test file: file paths only. URL fetching + magic-byte
 * sniffing are deferred to a follow-up (RED-383 v2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();

function compile(genPath: string, method: string, extraArgs: string[] = []): { ir: any | null; stderr: string } {
  const result = spawnSync(
    'ruby',
    [join(REPO_ROOT, 'ruby/cambium/compile.rb'), genPath, '--method', method, ...extraArgs],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    return { ir: null, stderr: result.stderr ?? '' };
  }
  return { ir: JSON.parse(result.stdout), stderr: result.stderr ?? '' };
}

describe('RED-383: grounded_in from: file paths', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red383-'));
    mkdirSync(join(scratch, 'app/gens'), { recursive: true });
    mkdirSync(join(scratch, 'src'), { recursive: true });
    // Permissive contracts.ts so the gen's `returns AnalysisReport`
    // resolves cleanly without dragging in the framework contracts.
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

  function writeGen(body: string): string {
    const path = join(scratch, 'app/gens/grounded.cmb.rb');
    writeFileSync(path, body.trim());
    return path;
  }

  it('bakes a relative text-file path into ir.context.<source>', () => {
    writeFileSync(join(scratch, 'app/gens/report.txt'), 'Incident report body. Latency p95 jumped from 120ms to 800ms.');
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "report.txt"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(stderr).toBe('');
    expect(ir.context.report).toBe('Incident report body. Latency p95 jumped from 120ms to 800ms.');
    // The `from:` value is preserved in policies.grounding for trace
    // observability — debuggers can see WHERE the doc came from.
    expect(ir.policies.grounding).toMatchObject({
      source: 'report',
      from: 'report.txt',
    });
  });

  it('accepts an absolute path', () => {
    const absPath = join(scratch, 'absolute-report.txt');
    writeFileSync(absPath, 'absolute body');
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "${absPath}"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(stderr).toBe('');
    expect(ir.context.report).toBe('absolute body');
  });

  it('emits a base64_pdf envelope for .pdf files', () => {
    // Tiny valid-shape PDF (header + minimal objects). The runtime
    // doesn't need real PDF semantics here — just verifying that the
    // compiler recognizes the extension and emits the envelope shape
    // documents.ts already consumes.
    const pdfBytes = Buffer.from(
      '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<</Type/Catalog>>\nendobj\nxref\n0 1\n0000000000 65535 f\ntrailer\n<</Size 1>>\n%%EOF\n',
      'binary',
    );
    writeFileSync(join(scratch, 'app/gens/doc.pdf'), pdfBytes);
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :doc, from: "doc.pdf"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(stderr).toBe('');
    expect(ir.context.doc).toEqual({
      kind: 'base64_pdf',
      data: pdfBytes.toString('base64'),
      media_type: 'application/pdf',
    });
  });

  it('emits a base64_image envelope for .png / .jpg / .webp / .gif', () => {
    const cases: Array<{ ext: string; media_type: string }> = [
      { ext: 'png', media_type: 'image/png' },
      { ext: 'jpg', media_type: 'image/jpeg' },
      { ext: 'jpeg', media_type: 'image/jpeg' },
      { ext: 'webp', media_type: 'image/webp' },
      { ext: 'gif', media_type: 'image/gif' },
    ];
    for (const { ext, media_type } of cases) {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // bogus 4-byte image; the extension is what's load-bearing here
      writeFileSync(join(scratch, `app/gens/img.${ext}`), bytes);
      const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :pic, from: "img.${ext}"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.context.pic).toEqual({
        kind: 'base64_image',
        data: bytes.toString('base64'),
        media_type,
      });
    }
  });

  it('resolves relative paths from the gen file directory (not cwd)', () => {
    // Put the fixture two levels up from the gen file's dir, exercising
    // the `..` segments.
    writeFileSync(join(scratch, 'shared-doc.txt'), 'shared body');
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :doc, from: "../../shared-doc.txt"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(stderr).toBe('');
    expect(ir.context.doc).toBe('shared body');
  });

  it('--arg overrides the from:-resolved value (runtime input wins)', () => {
    writeFileSync(join(scratch, 'app/gens/report.txt'), 'default-from-file');
    const overrideFixture = join(scratch, 'override.txt');
    writeFileSync(overrideFixture, 'runtime-override-wins');
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "report.txt"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze', ['--arg', overrideFixture]);
    expect(stderr).toBe('');
    expect(ir.context.report).toBe('runtime-override-wins');
  });

  it('errors clearly when the file is missing', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "nowhere/missing.txt"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(ir).toBeNull();
    expect(stderr).toMatch(/grounded_in :report from: "nowhere\/missing\.txt"/);
    expect(stderr).toMatch(/file not found/);
    expect(stderr).toMatch(/Relative paths resolve from the gen's directory/);
  });

  it('errors clearly when the path is a directory, not a file', () => {
    mkdirSync(join(scratch, 'app/gens/some-dir'));
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: "some-dir"
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(ir).toBeNull();
    expect(stderr).toMatch(/exists but is not a regular file/);
  });

  it('rejects non-String from: values at the DSL level', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: 42
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(ir).toBeNull();
    expect(stderr).toMatch(/from: must be a non-empty String/);
  });

  it('rejects empty-string from: values', () => {
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :report, from: ""
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const { ir, stderr } = compile(gen, 'analyze');
    expect(ir).toBeNull();
    expect(stderr).toMatch(/from: must be a non-empty String/);
  });

  it('grounded_in without from: behaves identically to pre-RED-383', () => {
    // Sanity that the new code path is gated on `from:` and gens that
    // don't use the kwarg are unchanged.
    const gen = writeGen(`
class Grounded < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  grounded_in :doc, require_citations: false
  def analyze(input); generate "go" do; with context: input; returns AnalysisReport; end; end
end
`);
    const argFixture = join(scratch, 'arg.txt');
    writeFileSync(argFixture, 'arg-via-cli');
    const { ir, stderr } = compile(gen, 'analyze', ['--arg', argFixture]);
    expect(stderr).toBe('');
    expect(ir.context.doc).toBe('arg-via-cli');
    expect(ir.policies.grounding).toEqual({
      source: 'doc',
      require_citations: false,
    });
    // `from` field absent when not declared
    expect(ir.policies.grounding.from).toBeUndefined();
  });
});
