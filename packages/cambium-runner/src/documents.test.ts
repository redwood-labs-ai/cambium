import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractDocuments, assertGroundingCompatibleWithDocuments } from './documents.js';

// Small valid base64 (encoded "PDF test content padded to cross the buffer-size sanity check").
const SMALL_PDF_B64 = Buffer.from('PDF test content padded to cross the buffer-size sanity check').toString('base64');
const SMALL_PNG_B64 = Buffer.from('PNG test content padded to cross the buffer-size sanity check').toString('base64');

describe('extractDocuments', () => {
  it('passes plain-string context through to textContext', () => {
    const { textContext, documents } = extractDocuments({
      context: { document: 'hello world', note: 'some note' },
    });
    expect(textContext).toEqual({ document: 'hello world', note: 'some note' });
    expect(documents).toEqual([]);
  });

  it('separates base64_pdf entries into documents', () => {
    const { textContext, documents } = extractDocuments({
      context: {
        prompt: 'summarize',
        invoice: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
      },
    });
    expect(textContext).toEqual({ prompt: 'summarize' });
    expect(documents).toHaveLength(1);
    expect(documents[0].key).toBe('invoice');
    expect(documents[0].kind).toBe('base64_pdf');
    expect(documents[0].data).toBe(SMALL_PDF_B64);
    expect(documents[0].media_type).toBe('application/pdf');
    expect(documents[0].decoded_bytes).toBeGreaterThan(0);
  });

  it('separates base64_image entries into documents', () => {
    const { textContext, documents } = extractDocuments({
      context: {
        screenshot: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: 'image/png' },
      },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].kind).toBe('base64_image');
    expect(documents[0].media_type).toBe('image/png');
    expect(textContext).toEqual({});
  });

  it('accepts jpeg, gif, webp for base64_image', () => {
    for (const mt of ['image/jpeg', 'image/gif', 'image/webp']) {
      const { documents } = extractDocuments({
        context: {
          img: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: mt },
        },
      });
      expect(documents[0].media_type).toBe(mt);
    }
  });

  it('rejects wrong media_type for kind', () => {
    expect(() => extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'image/png' },
      },
    })).toThrow(/kind "base64_pdf" requires media_type/);
  });

  it('rejects missing media_type', () => {
    expect(() => extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: SMALL_PDF_B64 },
      },
    })).toThrow(/media_type is required/);
  });

  it('rejects empty base64 data', () => {
    expect(() => extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: '', media_type: 'application/pdf' },
      },
    })).toThrow(/base64 data is empty/);
  });

  it('rejects malformed base64', () => {
    expect(() => extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: 'not valid base64 !!!', media_type: 'application/pdf' },
      },
    })).toThrow(/base64 data is malformed/);
  });

  it('accepts URL-safe base64 alphabet AND normalizes to standard alphabet in output', () => {
    // Create data with - and _ chars
    const buf = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);
    const urlSafe = buf.toString('base64url');  // uses - and _
    expect(urlSafe).toMatch(/[-_]/);
    const { documents } = extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: urlSafe + SMALL_PDF_B64, media_type: 'application/pdf' },
      },
    });
    expect(documents).toHaveLength(1);
    // The stored data MUST be standard alphabet — Anthropic rejects `-`/`_`.
    expect(documents[0].data).not.toMatch(/[-_]/);
    expect(documents[0].data).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('enforces per-doc size cap', () => {
    // Craft a base64 that decodes > 32 MiB. 32 MiB * 4/3 ≈ 43 MiB of base64 chars.
    const oversizeBuf = Buffer.alloc(33 * 1024 * 1024); // 33 MiB zero bytes
    const b64 = oversizeBuf.toString('base64');
    expect(() => extractDocuments({
      context: {
        big: { kind: 'base64_pdf', data: b64, media_type: 'application/pdf' },
      },
    })).toThrow(/exceeds per-doc cap of 33554432 bytes/);
  });

  describe('with CAMBIUM_MAX_DOC_BYTES_PER_RUN env', () => {
    let orig: string | undefined;
    beforeEach(() => { orig = process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN; });
    afterEach(() => {
      if (orig == null) delete process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN;
      else process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = orig;
    });

    it('enforces per-run total cap', () => {
      process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = '100'; // tiny cap
      expect(() => extractDocuments({
        context: {
          a: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
          b: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
          c: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
        },
      })).toThrow(/exceeds per-run cap 100 bytes/);
    });

    it('accepts valid override', () => {
      process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = '10000000';
      const { documents } = extractDocuments({
        context: {
          a: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
        },
      });
      expect(documents).toHaveLength(1);
    });

    it('rejects invalid env override', () => {
      process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = 'not-a-number';
      expect(() => extractDocuments({
        context: { a: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' } },
      })).toThrow(/must be a positive integer/);
    });
  });

  it('preserves ordering of documents as defined in context', () => {
    const { documents } = extractDocuments({
      context: {
        first: { kind: 'base64_pdf', data: SMALL_PDF_B64, media_type: 'application/pdf' },
        middle: 'text in between',
        second: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: 'image/png' },
      },
    });
    expect(documents.map(d => d.key)).toEqual(['first', 'second']);
  });

  it('handles missing ir.context gracefully', () => {
    const { textContext, documents } = extractDocuments({});
    expect(textContext).toEqual({});
    expect(documents).toEqual([]);
  });
});

describe('assertGroundingCompatibleWithDocuments', () => {
  it('no-ops when documents list is empty', () => {
    expect(() => assertGroundingCompatibleWithDocuments(
      { policies: { grounding: { source: 'document' } } },
      [],
    )).not.toThrow();
  });

  it('no-ops when grounding source is not set', () => {
    expect(() => assertGroundingCompatibleWithDocuments(
      {},
      [{ key: 'doc', kind: 'base64_pdf', data: 'x', media_type: 'application/pdf', decoded_bytes: 1 }],
    )).not.toThrow();
  });

  it('no-ops when grounding source does not match any document key', () => {
    expect(() => assertGroundingCompatibleWithDocuments(
      { policies: { grounding: { source: 'transcript' } } },
      [{ key: 'invoice', kind: 'base64_pdf', data: 'x', media_type: 'application/pdf', decoded_bytes: 1 }],
    )).not.toThrow();
  });

  it('throws when grounding source resolves to a document block', () => {
    expect(() => assertGroundingCompatibleWithDocuments(
      { policies: { grounding: { source: 'invoice' } } },
      [{ key: 'invoice', kind: 'base64_pdf', data: 'x', media_type: 'application/pdf', decoded_bytes: 1 }],
    )).toThrow(/grounded_in :invoice requires text/);
  });
});
