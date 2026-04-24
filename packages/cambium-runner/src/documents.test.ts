import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractDocuments } from './documents.js';

// Minimal valid PDF containing the distinctive string
// "Citable quote from the PDF" so extraction can be verified.
const TINY_PDF_BYTES = Buffer.from(
`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 14 Tf 72 720 Td (Citable quote from the PDF.) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000053 00000 n
0000000097 00000 n
0000000227 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
335
%%EOF`
);
const TINY_PDF_B64 = TINY_PDF_BYTES.toString('base64');

// A synthetic base64 payload that is NOT a valid PDF (used to confirm
// size/format validation runs independently of PDF parsing).
const FAKE_B64 = Buffer.from('fake payload padded out to cross the buffer-size sanity check').toString('base64');
const SMALL_PNG_B64 = Buffer.from('PNG test content padded to cross the buffer-size sanity check').toString('base64');

describe('extractDocuments', () => {
  it('passes plain-string context through to textContext', async () => {
    const { textContext, documents, groundingTextByKey } = await extractDocuments({
      context: { document: 'hello world', note: 'some note' },
    });
    expect(textContext).toEqual({ document: 'hello world', note: 'some note' });
    expect(documents).toEqual([]);
    expect(groundingTextByKey).toEqual({});
  });

  it('separates base64_pdf entries into documents AND extracts text for grounding', async () => {
    const { textContext, documents, groundingTextByKey } = await extractDocuments({
      context: {
        prompt: 'summarize',
        invoice: { kind: 'base64_pdf', data: TINY_PDF_B64, media_type: 'application/pdf' },
      },
    });
    expect(textContext).toEqual({ prompt: 'summarize' });
    expect(documents).toHaveLength(1);
    expect(documents[0].key).toBe('invoice');
    expect(documents[0].kind).toBe('base64_pdf');
    expect(documents[0].data).toBe(TINY_PDF_B64);
    expect(documents[0].media_type).toBe('application/pdf');
    expect(documents[0].decoded_bytes).toBeGreaterThan(0);
    // RED-323 core guarantee: PDF text is extracted and keyed by context
    // key so grounded_in can verify citations against it.
    expect(groundingTextByKey.invoice).toContain('Citable quote from the PDF');
  });

  it('separates base64_image entries into documents (no text extraction — images are OCR-only)', async () => {
    const { textContext, documents, groundingTextByKey } = await extractDocuments({
      context: {
        screenshot: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: 'image/png' },
      },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].kind).toBe('base64_image');
    expect(documents[0].media_type).toBe('image/png');
    expect(textContext).toEqual({});
    // Images don't populate groundingTextByKey — OCR is out of scope in v1.
    expect(groundingTextByKey.screenshot).toBeUndefined();
  });

  it('accepts jpeg, gif, webp for base64_image', async () => {
    for (const mt of ['image/jpeg', 'image/gif', 'image/webp']) {
      const { documents } = await extractDocuments({
        context: {
          img: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: mt },
        },
      });
      expect(documents[0].media_type).toBe(mt);
    }
  });

  it('rejects wrong media_type for kind', async () => {
    await expect(extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'image/png' },
      },
    })).rejects.toThrow(/kind "base64_pdf" requires media_type/);
  });

  it('rejects missing media_type', async () => {
    await expect(extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: FAKE_B64 },
      },
    })).rejects.toThrow(/media_type is required/);
  });

  it('rejects empty base64 data', async () => {
    await expect(extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: '', media_type: 'application/pdf' },
      },
    })).rejects.toThrow(/base64 data is empty/);
  });

  it('rejects malformed base64', async () => {
    await expect(extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: 'not valid base64 !!!', media_type: 'application/pdf' },
      },
    })).rejects.toThrow(/base64 data is malformed/);
  });

  it('accepts URL-safe base64 alphabet AND normalizes to standard alphabet in output', async () => {
    // Build a valid URL-safe base64 string that decodes to the tiny PDF
    // (prepend URL-safe chars as a separate payload that also needs
    // normalization). Simplest: base64-encode the PDF with URL-safe
    // alphabet by re-encoding. Node's Buffer can do this:
    const urlSafe = Buffer.from(TINY_PDF_BYTES).toString('base64url');
    const { documents } = await extractDocuments({
      context: {
        doc: { kind: 'base64_pdf', data: urlSafe, media_type: 'application/pdf' },
      },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].data).not.toMatch(/[-_]/);
    expect(documents[0].data).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('enforces per-doc size cap', async () => {
    const oversizeBuf = Buffer.alloc(33 * 1024 * 1024); // 33 MiB zero bytes
    const b64 = oversizeBuf.toString('base64');
    await expect(extractDocuments({
      context: {
        big: { kind: 'base64_pdf', data: b64, media_type: 'application/pdf' },
      },
    })).rejects.toThrow(/exceeds per-doc cap of 33554432 bytes/);
  });

  describe('with CAMBIUM_MAX_DOC_BYTES_PER_RUN env', () => {
    let orig: string | undefined;
    beforeEach(() => { orig = process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN; });
    afterEach(() => {
      if (orig == null) delete process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN;
      else process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = orig;
    });

    it('enforces per-run total cap', async () => {
      process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = '100'; // tiny cap
      await expect(extractDocuments({
        context: {
          a: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'application/pdf' },
          b: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'application/pdf' },
          c: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'application/pdf' },
        },
      })).rejects.toThrow(/exceeds per-run cap 100 bytes/);
    });

    it('rejects invalid env override', async () => {
      process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN = 'not-a-number';
      await expect(extractDocuments({
        context: { a: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'application/pdf' } },
      })).rejects.toThrow(/must be a positive integer/);
    });
  });

  it('preserves ordering of documents as defined in context', async () => {
    const { documents } = await extractDocuments({
      context: {
        first: { kind: 'base64_pdf', data: TINY_PDF_B64, media_type: 'application/pdf' },
        middle: 'text in between',
        second: { kind: 'base64_image', data: SMALL_PNG_B64, media_type: 'image/png' },
      },
    });
    expect(documents.map(d => d.key)).toEqual(['first', 'second']);
  });

  it('handles missing ir.context gracefully', async () => {
    const { textContext, documents, groundingTextByKey } = await extractDocuments({});
    expect(textContext).toEqual({});
    expect(documents).toEqual([]);
    expect(groundingTextByKey).toEqual({});
  });

  it('throws clear error when PDF is malformed (not a valid PDF)', async () => {
    // FAKE_B64 decodes to plain text "fake payload..." — not a valid PDF.
    // pdfjs will throw; we wrap with a clear error.
    await expect(extractDocuments({
      context: {
        bad: { kind: 'base64_pdf', data: FAKE_B64, media_type: 'application/pdf' },
      },
    })).rejects.toThrow(/PDF parse failed for document "bad"/);
  });

  it('populates groundingTextByKey for every PDF, keyed by context key', async () => {
    const { groundingTextByKey } = await extractDocuments({
      context: {
        invoice: { kind: 'base64_pdf', data: TINY_PDF_B64, media_type: 'application/pdf' },
        receipt: { kind: 'base64_pdf', data: TINY_PDF_B64, media_type: 'application/pdf' },
      },
    });
    expect(Object.keys(groundingTextByKey).sort()).toEqual(['invoice', 'receipt']);
    expect(groundingTextByKey.invoice).toContain('Citable quote from the PDF');
    expect(groundingTextByKey.receipt).toContain('Citable quote from the PDF');
  });
});
