// ── PDF text extraction (RED-323 grounded_in support) ─────────────────
//
// Extracts plain text from base64-encoded PDFs so Cambium's citation
// verifier (`grounded_in` + `require_citations`) can check cited quotes
// verbatim against the document content. Uses pdfjs-dist's legacy build
// which is Node-compatible (the default build targets browser canvas
// which Node doesn't have — we use only getTextContent, no rendering).
//
// Rationale: an earlier version of this feature rejected
// `grounded_in + base64_pdf` outright because Cambium had no way to
// verify citations against binary. That was the wrong call — gen
// authors legitimately want to reason over PDFs AND enforce citations.
// Extracting text here closes the loop: the model still sees the PDF
// as a native document block (preserves Claude's native PDF reasoning),
// and citations are verified against the extracted text on our side.

let cachedPdfLib: any = null;

async function loadPdfLib(): Promise<any> {
  if (cachedPdfLib) return cachedPdfLib;
  // The legacy build is the only one that runs under Node without a
  // browser shim for canvas/workers. It exports the same getDocument
  // surface as the modern build.
  cachedPdfLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return cachedPdfLib;
}

/**
 * Extract plain text from a base64-encoded PDF. Returns the concatenated
 * text content of every page, separated by page breaks.
 *
 * Throws on:
 *   - malformed PDF (pdfjs throws InvalidPDFException)
 *   - encrypted PDF with password requirement
 *   - totally empty text extraction (every page produced zero text —
 *     likely a scanned/image-only PDF that requires OCR, which is
 *     out of scope for v1; the caller sees a clear error rather than
 *     silently producing a doc where every citation fails verification)
 */
export async function extractPdfText(base64Data: string, docKey: string): Promise<string> {
  const pdfjsLib = await loadPdfLib();
  const buffer = Buffer.from(base64Data, 'base64');
  const uint8 = new Uint8Array(buffer);

  let doc: any;
  try {
    // `isEvalSupported: false` hardens against code-exec in malicious PDFs.
    // `useSystemFonts: false` keeps us self-contained (no fontconfig lookup).
    doc = await pdfjsLib.getDocument({
      data: uint8,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      // verbosity 0 = errors only; silences advisory "standardFontDataUrl"
      // warnings pdfjs emits for text-extraction scenarios where fonts
      // aren't needed.
      verbosity: 0,
    }).promise;
  } catch (e: any) {
    throw new Error(`PDF parse failed for document "${docKey}": ${e?.message ?? String(e)}`);
  }

  const pageTexts: string[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // content.items is a mix of TextItem (has `.str`) and TextMarkedContent
      // (no `.str`). Filter + join. Preserve approximate line structure by
      // treating `.hasEOL` as a newline.
      const parts: string[] = [];
      for (const item of content.items) {
        if (!item || typeof item !== 'object') continue;
        if ('str' in item && typeof item.str === 'string') {
          parts.push(item.str);
          if ('hasEOL' in item && item.hasEOL) {
            parts.push('\n');
          } else {
            parts.push(' ');
          }
        }
      }
      // Collapse the trailing whitespace on each page and normalize
      // multi-space runs to a single space (common from PDF positioning).
      const pageText = parts.join('').replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').trim();
      pageTexts.push(pageText);
    }
  } finally {
    // Release pdfjs resources (streams, workers) — important for long-
    // running Node processes that extract many PDFs.
    try { await doc.cleanup?.(); } catch {}
    try { await doc.destroy?.(); } catch {}
  }

  const fullText = pageTexts.join('\n\n').trim();

  if (fullText.length === 0) {
    throw new Error(
      `PDF extraction for document "${docKey}" produced no text — PDF may be scanned/image-only ` +
      `(needs OCR, not supported in v1). Either provide a text-selectable PDF or pre-extract text ` +
      `and pass it as a separate context key.`
    );
  }

  return fullText;
}
