// ── Native document input (RED-323) ──────────────────────────────────
//
// A typed envelope for binary/base64 context entries so the runner can
// distinguish text from PDFs/images. Plain-string context values pass
// through untouched (back-compat); typed objects
//   { kind: 'base64_pdf', data, media_type }
//   { kind: 'base64_image', data, media_type }
// get extracted so providers with native document support (Anthropic's
// Messages API today) can emit content blocks instead of inlining
// 30KB+ of base64 as text.
//
// Providers without native support (Ollama, oMLX) fail fast at dispatch
// rather than silently stringifying a base64 blob into the prompt.
//
// For `base64_pdf` entries the runner ALSO extracts the PDF's text via
// pdfjs-dist so that `grounded_in :<same_key>` can verify citations
// verbatim against the extracted text — the author gets native-PDF
// reasoning in the model AND Cambium's citation guarantee in one pass.
// An earlier version of this module refused the combo; that was wrong.

export type DocumentKind = 'base64_pdf' | 'base64_image';

export type DocumentBlock = {
  /** Which context key this came from — used by providers that label documents. */
  key: string;
  kind: DocumentKind;
  /** Raw base64 data, already validated for well-formedness. */
  data: string;
  /** e.g. "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp". */
  media_type: string;
  /** Size in bytes after base64 decode — computed at extraction time. */
  decoded_bytes: number;
};

/**
 * Output of `extractDocuments`. `groundingTextByKey` maps doc keys to
 * their extracted text, populated only for `base64_pdf` entries (images
 * require OCR, out of scope for v1). `getGroundingDocument` consults
 * this map before falling back to `ir.context[source]` so a gen that
 * uses `grounded_in :<same_key>` gets proper citation verification.
 */
export type ExtractedDocuments = {
  textContext: Record<string, any>;
  documents: DocumentBlock[];
  groundingTextByKey: Record<string, string>;
};

// Per-doc cap matches Anthropic's stated PDF limit. Images practically
// stay well under this.
const MAX_BYTES_PER_DOC = 32 * 1024 * 1024; // 32 MiB

// Per-run total cap, runaway-context guard. Override via env.
function maxBytesPerRun(): number {
  const raw = process.env.CAMBIUM_MAX_DOC_BYTES_PER_RUN;
  if (!raw) return 50 * 1024 * 1024; // 50 MiB default
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CAMBIUM_MAX_DOC_BYTES_PER_RUN must be a positive integer — got "${raw}"`);
  }
  return n;
}

const VALID_PDF_MEDIA_TYPES = new Set(['application/pdf']);
const VALID_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function isDocumentEntry(v: any): v is { kind: string; data: string; media_type?: string } {
  return (
    v != null
    && typeof v === 'object'
    && !Array.isArray(v)
    && typeof v.kind === 'string'
    && typeof v.data === 'string'
    && (v.kind === 'base64_pdf' || v.kind === 'base64_image')
  );
}

/**
 * Strict base64 validation + decoded-size computation. Throws on
 * malformed input so Anthropic doesn't return a cryptic API error.
 *
 * Accepts standard and URL-safe base64; rejects anything else. Returns
 * BOTH the decoded byte count AND the standard-alphabet-normalized
 * string, because Anthropic's Messages API rejects URL-safe chars
 * (`-`/`_`) in `source.data` — the caller MUST use the normalized form.
 */
function validateAndMeasureBase64(key: string, data: string): { decoded_bytes: number; normalized: string } {
  if (data.length === 0) {
    throw new Error(`document "${key}": base64 data is empty`);
  }
  // Allow standard + URL-safe alphabets + optional padding. No whitespace.
  // (Whitespace is technically permitted in RFC 4648 but callers should
  //  strip it; better to reject early than silently send a malformed
  //  payload to the provider.)
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) {
    throw new Error(`document "${key}": base64 data is malformed (unexpected characters or whitespace)`);
  }
  // Normalize URL-safe alphabet to standard base64. Anthropic's Messages
  // API does not accept `-`/`_` in source.data, so the normalized string
  // must be what we forward downstream.
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, 'base64');
  } catch (e: any) {
    throw new Error(`document "${key}": base64 decode failed — ${e?.message ?? String(e)}`);
  }
  // Buffer.from('...', 'base64') silently ignores invalid chars. Sanity-check
  // that decoded length roughly matches what base64 of that length implies.
  const expectedMin = Math.floor(data.length * 0.7);  // loose lower bound
  if (decoded.length < expectedMin) {
    throw new Error(`document "${key}": base64 decoded to suspiciously small buffer (${decoded.length} bytes from ${data.length} chars)`);
  }
  return { decoded_bytes: decoded.length, normalized };
}

function validateMediaType(key: string, kind: DocumentKind, mediaType: string | undefined): string {
  if (!mediaType || typeof mediaType !== 'string') {
    throw new Error(`document "${key}": media_type is required`);
  }
  if (kind === 'base64_pdf') {
    if (!VALID_PDF_MEDIA_TYPES.has(mediaType)) {
      throw new Error(`document "${key}": kind "base64_pdf" requires media_type in {${[...VALID_PDF_MEDIA_TYPES].join(', ')}}, got "${mediaType}"`);
    }
  } else if (kind === 'base64_image') {
    if (!VALID_IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new Error(`document "${key}": kind "base64_image" requires media_type in {${[...VALID_IMAGE_MEDIA_TYPES].join(', ')}}, got "${mediaType}"`);
    }
  }
  return mediaType;
}

/**
 * Walk `ir.context` and split into:
 *   - `textContext`: { key → string } that the existing prompt-assembly
 *     path consumes (unchanged behavior for non-doc entries)
 *   - `documents`: typed doc blocks, to be emitted as provider-native
 *     content blocks OR to trigger a fail-fast when the provider doesn't
 *     support them.
 *   - `groundingTextByKey`: extracted text for every `base64_pdf` entry,
 *     keyed by context key. Consumed by `getGroundingDocument` so that
 *     a gen using `grounded_in :<same_key>` can verify citations verbatim
 *     against the PDF's text. Not populated for `base64_image` (images
 *     require OCR, out of scope for v1).
 *
 * Throws `Error` on:
 *   - malformed base64
 *   - missing/invalid media_type for the declared kind
 *   - per-doc size over 32 MiB
 *   - per-run total size over CAMBIUM_MAX_DOC_BYTES_PER_RUN (default 50 MiB)
 *   - PDF parse failure or empty-text extraction (the caller sees a
 *     clear error rather than a silent citation-verification failure)
 *
 * Plain strings and arbitrary non-doc objects pass through into
 * `textContext` — the existing JSON.stringify fallback in step-handlers
 * keeps working for structured text context.
 *
 * Async because PDF text extraction is I/O-bound (pdfjs-dist).
 */
export async function extractDocuments(ir: any): Promise<ExtractedDocuments> {
  const context = ir?.context ?? {};
  const textContext: Record<string, any> = {};
  const documents: DocumentBlock[] = [];
  const groundingTextByKey: Record<string, string> = {};
  let totalBytes = 0;
  const perRunCap = maxBytesPerRun();

  // First pass: validate + normalize (sync). Separating from the async
  // text-extraction pass means we fail fast on size/format issues
  // BEFORE spending any time loading pdfjs-dist.
  for (const [key, value] of Object.entries(context)) {
    if (isDocumentEntry(value)) {
      const kind = value.kind as DocumentKind;
      const media_type = validateMediaType(key, kind, value.media_type);
      const { decoded_bytes, normalized } = validateAndMeasureBase64(key, value.data);
      if (decoded_bytes > MAX_BYTES_PER_DOC) {
        throw new Error(`document "${key}": ${decoded_bytes} bytes exceeds per-doc cap of ${MAX_BYTES_PER_DOC} bytes (32 MiB)`);
      }
      totalBytes += decoded_bytes;
      if (totalBytes > perRunCap) {
        throw new Error(`total document bytes ${totalBytes} exceeds per-run cap ${perRunCap} bytes — raise CAMBIUM_MAX_DOC_BYTES_PER_RUN if intentional`);
      }
      // IMPORTANT: store the standard-alphabet normalized form, not the
      // original value.data. Anthropic's Messages API rejects URL-safe
      // base64 (`-`/`_`) in source.data, so the normalized form is the
      // only variant that round-trips successfully.
      documents.push({ key, kind, data: normalized, media_type, decoded_bytes });
    } else {
      textContext[key] = value;
    }
  }

  // Second pass: extract text from every base64_pdf so `grounded_in`
  // can verify citations against real content. Only run when at least
  // one PDF is present — skips pdfjs-dist loading for the common
  // text-only case.
  const hasPdf = documents.some(d => d.kind === 'base64_pdf');
  if (hasPdf) {
    const { extractPdfText } = await import('./pdf-extract.js');
    for (const doc of documents) {
      if (doc.kind === 'base64_pdf') {
        groundingTextByKey[doc.key] = await extractPdfText(doc.data, doc.key);
      }
    }
  }

  return { textContext, documents, groundingTextByKey };
}
