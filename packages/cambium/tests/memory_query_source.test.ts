import { describe, it, expect } from 'vitest';
import { resolveSemanticQuery } from '../../cambium-runner/src/memory/runner-integration.js';
import type { MemoryDecl } from '../../cambium-runner/src/memory/types.js';

/**
 * RED-238: unit tests for the semantic-query resolver. This is a pure
 * function — it doesn't open a SQLite bucket or embed anything — so we
 * exercise it directly instead of routing through the full spawn-CLI
 * runtime test. The end-to-end integration is covered by the existing
 * semantic_memory.test.ts adding scenarios for the new forms once the
 * CLI path is through; this file is the targeted behavior contract.
 */

const base: MemoryDecl = {
  name: 'facts',
  scope: 'session',
  strategy: 'semantic',
  top_k: 3,
  embed: 'omlx:bge-small-en',
};

describe('resolveSemanticQuery (RED-238)', () => {
  it('defaults to ctx.input when neither query nor arg_field is set', () => {
    const out = resolveSemanticQuery(base, 'raw incident text');
    expect(out).toEqual({ text: 'raw incident text', source: 'default' });
  });

  it('passes a literal query through', () => {
    const out = resolveSemanticQuery(
      { ...base, query: 'support triage anchor' },
      'raw incident text',
    );
    expect(out).toEqual({ text: 'support triage anchor', source: 'literal' });
  });

  it('plucks a top-level field from a JSON ctx.input (string value)', () => {
    const input = JSON.stringify({ question: 'What caused the outage?', meta: 1 });
    const out = resolveSemanticQuery({ ...base, arg_field: 'question' }, input);
    expect(out).toEqual({ text: 'What caused the outage?', source: 'arg_field' });
  });

  it('JSON-stringifies a non-string field value (numbers, objects, arrays)', () => {
    const input = JSON.stringify({ code: 42, nested: { a: 1 }, tags: ['x', 'y'] });
    expect(resolveSemanticQuery({ ...base, arg_field: 'code' }, input).text).toBe('42');
    expect(resolveSemanticQuery({ ...base, arg_field: 'nested' }, input).text).toBe('{"a":1}');
    expect(resolveSemanticQuery({ ...base, arg_field: 'tags' }, input).text).toBe('["x","y"]');
  });

  it('throws with decl-local context when ctx.input is not JSON', () => {
    expect(() =>
      resolveSemanticQuery({ ...base, arg_field: 'question' }, 'this is not json'),
    ).toThrow(/memory 'facts' requested arg_field: 'question' but ctx\.input is not valid JSON/);
  });

  it('throws when JSON ctx.input is an array, number, or null (not an object)', () => {
    expect(() =>
      resolveSemanticQuery({ ...base, arg_field: 'question' }, JSON.stringify([1, 2, 3])),
    ).toThrow(/parsed as an array, not a JSON object/);
    expect(() =>
      resolveSemanticQuery({ ...base, arg_field: 'question' }, JSON.stringify(42)),
    ).toThrow(/parsed as number, not a JSON object/);
    expect(() =>
      resolveSemanticQuery({ ...base, arg_field: 'question' }, 'null'),
    ).toThrow(/parsed as null, not a JSON object/);
  });

  it('throws when the named field is missing, listing the available keys', () => {
    const input = JSON.stringify({ query: 'whoops wrong name', meta: 1 });
    expect(() =>
      resolveSemanticQuery({ ...base, arg_field: 'question' }, input),
    ).toThrow(/arg_field: 'question' which is not present.*Available top-level fields: \[query, meta\]/);
  });

  it('prefers query over arg_field if both are set (DSL prevents this; defensive)', () => {
    // The Ruby DSL makes this unreachable — but if someone hand-crafts
    // an IR with both set, the literal wins rather than throwing.
    const out = resolveSemanticQuery(
      { ...base, query: 'literal', arg_field: 'question' },
      JSON.stringify({ question: 'other' }),
    );
    expect(out).toEqual({ text: 'literal', source: 'literal' });
  });

  it('respects an empty-string query: as a deliberate literal (not a falsy-skip)', () => {
    const out = resolveSemanticQuery({ ...base, query: '' }, 'ignored');
    expect(out).toEqual({ text: '', source: 'literal' });
  });
});
