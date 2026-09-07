// ── Context resolution (RED-276, RED-323, RED-382) ────────────────────
//
// A gen that declares `grounded_in :linear_issue` expects the context
// document to live under `ir.context.linear_issue` — not the hardcoded
// `ir.context.document`. The compiler (`ruby/cambium/compile.rb`)
// already emits the context under the grounding source's name when one
// is declared. This helper mirrors that on the TS side: all read sites
// that want "the primary document content" should go through here so
// the lookup stays consistent end to end.
//
// RED-323 extension: when the grounding source resolves to a
// `base64_pdf` document envelope rather than a plain string, the
// runner extracts text from the PDF and passes it here via the
// `groundingTextByKey` override map. That way `grounded_in + PDF`
// gets full citation verification — the model sees the PDF as a
// native document block (Anthropic), and Cambium verifies cited
// quotes against the extracted text.
//
// RED-382: when the primary doc is a non-string value (e.g., a pipeline
// step binds an upstream sub-gen's structured output into `document`
// via `with: { document: bind(:axes) }`), JSON-serialize it so the
// downstream prompt actually sees the data. Pre-fix, the type guard
// `typeof ctx[source] === 'string'` returned '' for objects, and the
// sub-gen's prompt got an empty DOCUMENT: section — silent data loss.
// Citation grounding still works against the JSON-stringified form
// (the model is expected to cite that representation).
//
// Fallback order:
//   1. groundingTextByKey[source]  (RED-323: extracted PDF text)
//   2. ir.context[source]          (RED-276 grounding source key)
//   3. ir.context.document         (legacy fallback)
//   4. empty string
//
// #169 (DEC-001): format-derived text — the plain-text view of a Markdown
// or JSON source that `grounded_in ... format:` produces — is deliberately
// NOT in `groundingTextByKey` and must not be "unified" into it later.
// This map is not verifier-only: it feeds prompt assembly, every RED-175
// semantic repair prompt, `enrich`, and compound review, all through this
// function. A PDF belongs here because the extracted text is the ONLY text
// there is; for a text source the raw string already is the text, and
// substituting a stripped view would silently change what the model sees
// and move the prompt-cache key. The derived view travels a verifier-only
// channel instead: `CorrectorContext.derivedDocument` (see
// `grounding-text.ts` and the wiring in `runner.ts`).

type IR = any;

function coerceDocumentValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  // RED-323: typed document envelopes ({ kind: 'base64_pdf' | 'base64_image' })
  // are NOT serialized here — the runner handles them via the
  // documents/groundingTextByKey path (Anthropic gets a native doc
  // block; non-Anthropic providers fail fast). Serializing the
  // envelope would dump the base64 data into the prompt. Return null
  // so the existing extract-then-override flow keeps working.
  if (
    typeof v === 'object' &&
    'kind' in (v as any) &&
    ((v as any).kind === 'base64_pdf' || (v as any).kind === 'base64_image')
  ) {
    return null;
  }
  // RED-382: every other non-string structured value (pipeline-injected
  // bind() target, hand-rolled IR with a JSON-typed context, etc.)
  // gets JSON.stringify'd so the downstream prompt actually sees the
  // shape. Mirrors the `_enriched` key path that already stringified.
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return null;
  }
}

export function getGroundingDocument(ir: IR, groundingTextByKey?: Record<string, string>): string {
  const source = ir?.policies?.grounding?.source;
  const ctx = ir?.context ?? {};
  if (source && groundingTextByKey && typeof groundingTextByKey[source] === 'string') {
    return groundingTextByKey[source];
  }
  if (source) {
    const v = coerceDocumentValue(ctx[source]);
    if (v !== null) return v;
  }
  const docVal = coerceDocumentValue(ctx.document);
  if (docVal !== null) return docVal;
  return '';
}
