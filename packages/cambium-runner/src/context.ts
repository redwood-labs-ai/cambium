// ── Context resolution (RED-276, RED-323) ─────────────────────────────
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
// Fallback order:
//   1. groundingTextByKey[source]  (RED-323: extracted PDF text)
//   2. ir.context[source]          (plain-string context, RED-276)
//   3. ir.context.document         (legacy fallback)
//   4. empty string
// The legacy fallback preserves back-compat for any IR produced by a
// compiler that hasn't been updated (shouldn't happen in-tree, but
// defensive for third-party compilers or old trace replays).

type IR = any;

export function getGroundingDocument(ir: IR, groundingTextByKey?: Record<string, string>): string {
  const source = ir?.policies?.grounding?.source;
  const ctx = ir?.context ?? {};
  if (source && groundingTextByKey && typeof groundingTextByKey[source] === 'string') {
    return groundingTextByKey[source];
  }
  if (source && typeof ctx[source] === 'string') return ctx[source];
  if (typeof ctx.document === 'string') return ctx.document;
  return '';
}
