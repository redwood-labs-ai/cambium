/**
 * RED-419 C1/C2: `returns do … end` block → inline `returnSchema` in the IR.
 *
 * Exercises the Ruby DSL collector through the actual compile.rb output
 * (same idiom as compile-bare.test.ts): spawn ruby against a tmp-dir
 * fixture and assert the emitted IR. Requires `ruby` on PATH.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPILE_RB = resolve(__dirname, '../../..', 'ruby/cambium/compile.rb');

const BLOCK_FIXTURE = `
class BlockGen < GenModel
  model "ollama:test"
  system "test prompt"

  returns do
    field :name, String
    field :count, Integer, optional: true
    field :ratio, Float
    field :flag, Boolean
    field :tags, [String]
    field :status, String, enum: %w[active archived]
    field :note, String, description: "free text"
    field :details do
      field :summary, String
    end
    field :items, [] do
      field :label, String
      field :n, Integer, optional: true
    end
  end

  def analyze(input)
    generate "do it"
  end
end
`;

const SYMBOL_FIXTURE = `
class SymbolGen < GenModel
  model "ollama:test"
  system "test prompt"

  returns :SomeContract

  def analyze(input)
    generate "do it"
  end
end
`;

function fixtureWith(returnsBlock: string): string {
  return `
class BadGen < GenModel
  model "ollama:test"
  system "test prompt"

  returns do
${returnsBlock}
  end

  def analyze(input)
    generate "do it"
  end
end
`;
}

describe('RED-419 returns do … end → inline returnSchema', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-returns-block-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function compile(contents: string): { status: number; stdout: string; stderr: string } {
    const path = join(tmp, 'gen.cmb.rb');
    writeFileSync(path, contents);
    const result = spawnSync('ruby', [COMPILE_RB, path, '--method', 'analyze'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('emits a Draft-07 returnSchema for the block form (and no returnSchemaId)', () => {
    const { status, stdout, stderr } = compile(BLOCK_FIXTURE);
    expect(status, `stderr: ${stderr}`).toBe(0);
    const ir = JSON.parse(stdout);

    expect(ir.returnSchemaId).toBeUndefined();
    expect(ir.returnSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        flag: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'archived'] },
        note: { type: 'string', description: 'free text' },
        details: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              n: { type: 'integer' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      // `count` is optional → omitted from required.
      required: ['name', 'ratio', 'flag', 'tags', 'status', 'note', 'details', 'items'],
      additionalProperties: false,
      $id: 'BlockGenOutput',
    });
  });

  it('the symbol form is untouched: returnSchemaId set, no returnSchema', () => {
    // Compiles against no contracts file → name-existence check is
    // best-effort skipped (RED-373), so SomeContract passes through.
    const { status, stdout, stderr } = compile(SYMBOL_FIXTURE);
    expect(status, `stderr: ${stderr}`).toBe(0);
    const ir = JSON.parse(stdout);
    expect(ir.returnSchemaId).toBe('SomeContract');
    expect(ir.returnSchema).toBeUndefined();
  });

  it('rejects an unknown type token with a CompileError', () => {
    const { status, stderr } = compile(fixtureWith('    field :x, Hash'));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown type 'Hash'/);
  });

  it('rejects enum on a non-String field', () => {
    const { status, stderr } = compile(fixtureWith('    field :x, Integer, enum: [1, 2]'));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/`enum:` is supported on String fields only/);
  });

  it('rejects a duplicate field name', () => {
    const { status, stderr } = compile(fixtureWith('    field :x, String\n    field :x, Integer'));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/duplicate field name 'x'/);
  });

  it('rejects a [T] array literal with more than one element type', () => {
    const { status, stderr } = compile(fixtureWith('    field :x, [String, Integer]'));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/array literal must have exactly one element type/);
  });

  it('rejects passing both a symbol and a block to returns', () => {
    const both = `
class BothGen < GenModel
  model "ollama:test"
  system "test prompt"

  returns :Foo do
    field :x, String
  end

  def analyze(input)
    generate "do it"
  end
end
`;
    const { status, stderr } = compile(both);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/not both/);
  });
});
