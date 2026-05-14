/**
 * Tests for the pure helper `resolveEnrichmentInput` (RED-327).
 *
 * The wider enrichment loop is exercised end-to-end via runGen in
 * `corrector-feedback.test.ts` and friends; this file pins the v1
 * routing decision for base64_pdf / base64_image envelopes vs plain
 * context values without spinning up a real sub-agent.
 */

import { describe, expect, it } from 'vitest';
import { resolveEnrichmentInput } from './enrich.js';

describe('resolveEnrichmentInput (RED-327)', () => {
  // ── plain values pass through ───────────────────────────────────

  it('passes a plain string through unchanged', () => {
    const r = resolveEnrichmentInput('hello world', 'document', {});
    expect(r).toEqual({ kind: 'use', value: 'hello world' });
  });

  it('passes a plain dict through unchanged', () => {
    const r = resolveEnrichmentInput({ foo: 'bar' }, 'document', {});
    expect(r).toEqual({ kind: 'use', value: { foo: 'bar' } });
  });

  it('passes a plain list through unchanged', () => {
    const r = resolveEnrichmentInput(['a', 'b'], 'document', {});
    expect(r).toEqual({ kind: 'use', value: ['a', 'b'] });
  });

  it('passes null and undefined through unchanged', () => {
    expect(resolveEnrichmentInput(null, 'd', {})).toEqual({ kind: 'use', value: null });
    expect(resolveEnrichmentInput(undefined, 'd', {})).toEqual({ kind: 'use', value: undefined });
  });

  it('does NOT treat an object that happens to have a `kind` field as an envelope unless it matches an envelope kind', () => {
    // A caller's domain object that happens to have `kind: 'invoice'`
    // shouldn't be misclassified.
    const r = resolveEnrichmentInput(
      { kind: 'invoice', total: 100 },
      'document',
      {},
    );
    expect(r).toEqual({ kind: 'use', value: { kind: 'invoice', total: 100 } });
  });

  // ── base64_pdf → extracted text ─────────────────────────────────

  it('routes a base64_pdf envelope to the extracted text', () => {
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'document', {
      document: 'extracted PDF body text',
    });
    expect(r).toEqual({ kind: 'use', value: 'extracted PDF body text' });
  });

  it('routes by the field-specific extracted-text entry', () => {
    // groundingTextByKey is keyed per-field; make sure we look up the
    // right key, not just any string in the map.
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'report', {
      document: 'wrong field',
      report: 'right field',
    });
    expect(r).toEqual({ kind: 'use', value: 'right field' });
  });

  it('returns a skip when a base64_pdf has no extracted text (image-only PDF)', () => {
    // extractDocuments returns empty string or skips the entry if the
    // PDF's text layer is empty. Surface a clear OCR-upstream pointer.
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'document', {});
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') {
      expect(r.reason).toMatch(/no extractable text/);
      expect(r.reason).toMatch(/OCR upstream/);
    }
  });

  // ── base64_image → always skip ──────────────────────────────────

  it('skips a base64_image envelope with a clear reason', () => {
    const envelope = { kind: 'base64_image', data: '...', media_type: 'image/png' };
    const r = resolveEnrichmentInput(envelope, 'screenshot', {});
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') {
      expect(r.reason).toMatch(/base64_image envelope/);
      expect(r.reason).toMatch(/vision-model sub-agents/);
      expect(r.reason).toMatch(/screenshot/);  // includes the field name
    }
  });

  it('skips base64_image even when a same-key text entry happens to exist', () => {
    // Defensive: don't accidentally route an image to a PDF-extracted-
    // text entry that shares the field name.
    const envelope = { kind: 'base64_image', data: '...', media_type: 'image/jpeg' };
    const r = resolveEnrichmentInput(envelope, 'doc', { doc: 'unrelated text' });
    expect(r.kind).toBe('skip');
  });

  // ── back-compat ─────────────────────────────────────────────────

  it('back-compat: an envelope with a numeric data field is treated as a plain object (not an envelope)', () => {
    // The isDocumentEntry-style guard requires `data: string`; defensive
    // against malformed envelopes that have the right kind but wrong
    // data type.
    const r = resolveEnrichmentInput(
      { kind: 'base64_pdf', data: 12345 },
      'document',
      {},
    );
    // Falls through to the "use as-is" branch — our guard is strict
    // about envelope shape so a malformed envelope doesn't silently
    // trigger the extracted-text path.
    expect(r.kind).toBe('use');
  });
});
