/**
 * #182: `exclude_from_prefix :page_id` names context keys that must reach
 * the model but must NOT contribute to `cacheablePrefix` byte-identity
 * (DEC-011 — a per-gen declaration, not a per-key sigil).
 *
 * Three halves:
 *   - the declaration → top-level `ir.excludeFromPrefix`, **absent** (not
 *     `[]`, not null) when the gen declares none, so every pre-#182 gen
 *     compiles to the bytes it did before (the golden gate);
 *   - DEC-013's two compile errors — naming the `grounded_in` source, and
 *     naming a `_`-prefixed key;
 *   - the things deliberately NOT validated: a key that never appears in
 *     `ir.context` (context is runtime, the declaration is compile-time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();

function compile(genPath: string, method: string): { ir: any | null; stderr: string } {
  const result = spawnSync(
    'ruby',
    [join(REPO_ROOT, 'ruby/cambium/compile.rb'), genPath, '--method', method],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    return { ir: null, stderr: result.stderr ?? '' };
  }
  return { ir: JSON.parse(result.stdout), stderr: result.stderr ?? '' };
}

describe('#182: exclude_from_prefix', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-182-'));
    mkdirSync(join(scratch, 'app/gens'), { recursive: true });
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  /** `body` is spliced into the class body verbatim, so a test can control
   *  the DECLARATION ORDER of grounded_in vs exclude_from_prefix. */
  function writeGen(body: string): string {
    const path = join(scratch, 'app/gens/excl.cmb.rb');
    writeFileSync(
      path,
      `
class Excl < GenModel
  model "omlx:stub"
  system "inline"
  returns do
    field :summary, String
  end
  ${body}
  def analyze(input); generate "go" do; with context: input; end; end
end
`.trim(),
    );
    return path;
  }

  describe('IR emission', () => {
    it('emits declared keys in declaration order', () => {
      const gen = writeGen('exclude_from_prefix :page_id, :run_seq');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.excludeFromPrefix).toEqual(['page_id', 'run_seq']);
    });

    it('accepts strings as well as symbols, and accumulates across calls', () => {
      const gen = writeGen('exclude_from_prefix "page_id"\n  exclude_from_prefix :run_seq');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.excludeFromPrefix).toEqual(['page_id', 'run_seq']);
    });

    it('de-duplicates a repeated key rather than emitting it twice', () => {
      const gen = writeGen('exclude_from_prefix :page_id, :page_id\n  exclude_from_prefix :page_id');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.excludeFromPrefix).toEqual(['page_id']);
    });

    // The byte-identity gate. `[]` or `null` here would diff every golden
    // snapshot in the corpus on upgrade — same omitted-when-unused rule as
    // `effort` and `model.fallbacks`.
    it('omits the key entirely when the gen declares none', () => {
      const gen = writeGen('# no declaration');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect('excludeFromPrefix' in ir).toBe(false);
    });

    it('omits the key entirely for a bare `exclude_from_prefix` with no arguments', () => {
      const gen = writeGen('exclude_from_prefix');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect('excludeFromPrefix' in ir).toBe(false);
    });

    it('coexists with grounded_in on a different key', () => {
      const gen = writeGen('grounded_in :doc, require_citations: true\n  exclude_from_prefix :page_id');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.excludeFromPrefix).toEqual(['page_id']);
      expect(ir.policies.grounding.source).toBe('doc');
    });

    // DEC-013: context is runtime, the declaration is compile-time. A gen
    // cannot know which optional keys a caller supplies, so naming a key
    // that never arrives is silence, not an error.
    it('does not require the key to appear in ir.context', () => {
      const gen = writeGen('exclude_from_prefix :never_supplied');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(stderr).toBe('');
      expect(ir.excludeFromPrefix).toEqual(['never_supplied']);
      expect('never_supplied' in ir.context).toBe(false);
    });
  });

  describe('DEC-013(a): naming the grounding source is a compile error', () => {
    it('rejects it when grounded_in comes first', () => {
      const gen = writeGen('grounded_in :doc\n  exclude_from_prefix :doc');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain('exclude_from_prefix :doc names the `grounded_in` source');
    });

    // Order-independence is why this check lives in compile.rb and not in
    // the DSL method — a class body may declare the two in either order.
    it('rejects it when exclude_from_prefix comes first', () => {
      const gen = writeGen('exclude_from_prefix :doc\n  grounded_in :doc');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain('exclude_from_prefix :doc names the `grounded_in` source');
    });

    it('rejects it when the source is one of several excluded keys', () => {
      const gen = writeGen('grounded_in :doc\n  exclude_from_prefix :page_id, :doc');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain('exclude_from_prefix :doc names the `grounded_in` source');
    });
  });

  describe('DEC-013(b): naming a `_`-prefixed key is a compile error', () => {
    it('rejects a framework-internal key', () => {
      const gen = writeGen('exclude_from_prefix :_pipeline_arg');
      const { ir, stderr } = compile(gen, 'analyze');
      expect(ir).toBeNull();
      expect(stderr).toContain('`_`-prefixed context keys are framework-internal');
    });
  });

  describe('key shape', () => {
    it.each(['"Page Id"', '"PageId"', '"9lives"', '"page-id"', '"__proto__"'])(
      'rejects %s',
      (literal) => {
        const gen = writeGen(`exclude_from_prefix :${literal}`);
        const { ir, stderr } = compile(gen, 'analyze');
        expect(ir).toBeNull();
        expect(stderr).toContain('exclude_from_prefix');
      },
    );
  });
});
