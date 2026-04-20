import { describe, expect, it } from 'vitest';
import { getGroundingDocument } from './context.js';

describe('getGroundingDocument (RED-276)', () => {
  it('returns the value under the grounding source when declared', () => {
    const ir = {
      policies: { grounding: { source: 'linear_issue', require_citations: false } },
      context: { linear_issue: 'the issue body', document: 'should not win' },
    };
    expect(getGroundingDocument(ir)).toBe('the issue body');
  });

  it('falls back to context.document when no grounding declared', () => {
    const ir = { context: { document: 'the doc' } };
    expect(getGroundingDocument(ir)).toBe('the doc');
  });

  it('falls back to context.document when grounding.source is not present in context', () => {
    // Defensive: compiler is updated but somehow the context key doesn't
    // match. Keep the run going off the document key rather than empty.
    const ir = {
      policies: { grounding: { source: 'nonexistent', require_citations: true } },
      context: { document: 'the doc' },
    };
    expect(getGroundingDocument(ir)).toBe('the doc');
  });

  it('returns empty string for an IR with no context', () => {
    expect(getGroundingDocument({})).toBe('');
    expect(getGroundingDocument({ context: null })).toBe('');
    expect(getGroundingDocument({ context: {} })).toBe('');
  });

  it('ignores non-string context values', () => {
    const ir = {
      policies: { grounding: { source: 'thing' } },
      context: { thing: { nested: 'obj' } },
    };
    // Non-string under the source → fall through to document or empty.
    expect(getGroundingDocument(ir)).toBe('');
  });

  it('handles undefined policies gracefully', () => {
    const ir = { context: { document: 'ok' } };
    expect(getGroundingDocument(ir)).toBe('ok');
  });
});
