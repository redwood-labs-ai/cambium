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
 *
 * Throws `Error` on:
 *   - malformed base64
 *   - missing/invalid media_type for the declared kind
 *   - per-doc size over 32 MiB
 *   - per-run total size over CAMBIUM_MAX_DOC_BYTES_PER_RUN (default 50 MiB)
 *
 * Plain strings and arbitrary non-doc objects pass through into
 * `textContext` — the existing JSON.stringify fallback in step-handlers
 * keeps working for structured text context.
 */
export function extractDocuments(ir: any): { textContext: Record<string, any>; documents: DocumentBlock[] } {
  const context = ir?.context ?? {};
  const textContext: Record<string, any> = {};
  const documents: DocumentBlock[] = [];
  let totalBytes = 0;
  const perRunCap = maxBytesPerRun();

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

  return { textContext, documents };
}

/**
 * Grounding interaction guard. `grounded_in :document` requires text
 * for verbatim quote verification. If the grounding source resolves to
 * a base64 document, fail fast with a clear error — don't let the
 * downstream citation check return confusing "document is empty"
 * results.
 */
export function assertGroundingCompatibleWithDocuments(ir: any, documents: DocumentBlock[]): void {
  if (documents.length === 0) return;
  const source = ir?.policies?.grounding?.source;
  if (!source) return;
  if (documents.some(d => d.key === source)) {
    throw new Error(
      `grounded_in :${source} requires text (for verbatim quote verification), but ir.context.${source} is a ${documents.find(d => d.key === source)?.kind} document. ` +
      `Either drop grounded_in, or pre-extract text from the document into a separate key.`
    );
  }
}
