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

describe('getGroundingDocument with groundingTextByKey override (RED-323)', () => {
  it('prefers override text when grounding source is a PDF doc envelope', () => {
    const ir = {
      policies: { grounding: { source: 'invoice', require_citations: true } },
      // In the RED-323 flow, ir.context.invoice is a doc envelope — not a
      // string — so the legacy lookup returns empty. The override map
      // carries the PDF-extracted text and must win.
      context: { invoice: { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' } },
    };
    const override = { invoice: 'Citable quote from the PDF.' };
    expect(getGroundingDocument(ir, override)).toBe('Citable quote from the PDF.');
  });

  it('override takes precedence even if a string context value exists at the same key', () => {
    // Defensive: author might pass both — an override should always win.
    const ir = {
      policies: { grounding: { source: 'invoice' } },
      context: { invoice: 'plain text fallback' },
    };
    const override = { invoice: 'pdf-extracted text' };
    expect(getGroundingDocument(ir, override)).toBe('pdf-extracted text');
  });

  it('falls back to plain-string context when override does not cover the source', () => {
    const ir = {
      policies: { grounding: { source: 'issue' } },
      context: { issue: 'issue text', invoice: { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' } },
    };
    const override = { invoice: 'pdf text' };  // no override for 'issue'
    expect(getGroundingDocument(ir, override)).toBe('issue text');
  });

  it('omitting the override arg is identical to pre-RED-323 behavior', () => {
    const ir = {
      policies: { grounding: { source: 'note' } },
      context: { note: 'plain note' },
    };
    expect(getGroundingDocument(ir)).toBe('plain note');
  });
});
