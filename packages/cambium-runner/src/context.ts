// ── Context resolution (RED-276) ──────────────────────────────────────
//
// A gen that declares `grounded_in :linear_issue` expects the context
// document to live under `ir.context.linear_issue` — not the hardcoded
// `ir.context.document`. The compiler (`ruby/cambium/compile.rb`)
// already emits the context under the grounding source's name when one
// is declared. This helper mirrors that on the TS side: all read sites
// that want "the primary document content" should go through here so
// the lookup stays consistent end to end.
//
// Fallback order: grounding-source key → `document` key → empty string.
// The middle fallback preserves back-compat for any IR produced by a
// compiler that hasn't been updated (shouldn't happen in-tree, but
// defensive for third-party compilers or old trace replays).

type IR = any;

export function getGroundingDocument(ir: IR): string {
  const source = ir?.policies?.grounding?.source;
  const ctx = ir?.context ?? {};
  if (source && typeof ctx[source] === 'string') return ctx[source];
  if (typeof ctx.document === 'string') return ctx.document;
  return '';
}
