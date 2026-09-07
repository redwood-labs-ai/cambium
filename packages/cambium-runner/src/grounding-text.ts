// ── Format-aware grounding text (#169) ────────────────────────────────
//
// The model sees the source document exactly as it is. The verifier gets
// a second, derived view of the same document, and a citation passes if
// it matches EITHER (raw first, derived second — see the correctors).
//
// Why: `citations.ts` / `field_values.ts` normalize case, whitespace and
// a little punctuation, then substring-match. Markup and JSON escapes
// stay in the haystack, so a model that quotes the *visible* text of
// `Revenue grew **12%** in Q3`, or the decoded value of
// `"Restarted twice.\nStill \"flapping\"."`, is told its correct quote
// was fabricated — and the repair loop then fires against a correct
// output. Deriving a plain-text view of the document closes that gap
// without touching what the model is shown (DEC-001: this text never
// enters `groundingTextByKey`, so no prompt and no cache key moves).
//
// Both derivers are pure functions of their input — no locale, no
// randomness, no I/O, no dependencies (Markdown parsers are out under
// the dependency policy; the raw fallback backstops any imperfection,
// so a deriver only ever has to ADD matches, never be exhaustive).

import { isDocumentEntry } from './documents.js';

/**
 * The verifier's view of `value` under `format`, or `undefined` when
 * there is nothing useful to derive (plain text, an unknown format, a
 * binary document envelope, an empty document, unparseable JSON).
 * `undefined` is never an error: verification falls back to raw-only,
 * which is exactly the pre-#169 behavior.
 */
export function deriveGroundingText(format: string, value: unknown): string | undefined {
  if (format !== 'markdown' && format !== 'json') return undefined;
  if (value === null || value === undefined) return undefined;
  // RED-323 envelopes are handled by the documents/groundingTextByKey
  // path; there is no text here to derive from (and compile.rb refuses
  // an explicit `format:` on one).
  if (isDocumentEntry(value)) return undefined;

  if (typeof value === 'string') {
    if (value === '') return undefined;
    return format === 'markdown' ? markdownToText(value) : jsonToText(value);
  }
  // A structured context value (a pipeline `bind()` target, a hand-rolled
  // IR) is already parsed JSON — render it directly. There is no
  // meaningful Markdown view of a non-string.
  if (typeof value === 'object') {
    return format === 'json' ? jsonToText(value) : undefined;
  }
  return undefined;
}

// ── Markdown ──────────────────────────────────────────────────────────

const FENCE_RE = /^\s*(```|~~~)/;
// `---`, `***`, `___`, and their spaced variants.
const HR_RE = /^\s*([-*_])\s*(\1\s*){2,}$/;
// `|---|:---:|`, with or without the outer pipes.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING_RE = /^#{1,6}\s+/;
const HEADING_TRAIL_RE = /\s+#+\s*$/;
const BLOCKQUOTE_RE = /^\s*>\s?/;
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
const TASK_BOX_RE = /^\[[ xX]\]\s+/;
const REF_DEF_RE = /^\s*\[[^\]]+\]:\s+\S+.*$/;

// A-002 (DEC-012): defense in depth on top of the linear-by-construction
// inline rules below. Real prose lines are orders of magnitude shorter
// than this; a single 500 KB "line" is the adversarial shape, and leaving
// it untransformed costs nothing — raw matching still applies, which is
// exactly the behavior every text source had before `format:` existed.
// Derivation runs synchronously inside `runGen`, so an unbounded pass here
// would block every in-flight run under `cambium serve`.
const MAX_INLINE_LINE_CHARS = 20_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Markdown → the text a reader actually sees. Line-oriented,
 * fence-aware, delimiter-aware; not a CommonMark parser and not trying
 * to be one.
 */
export function markdownToText(md: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of md.split('\n')) {
    // 1. Fenced code. The fence lines themselves go; what's between them
    //    is emitted verbatim, so asterisks and underscores in code are
    //    never mistaken for emphasis.
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }

    // 2. Rules and table separators carry no text.
    if (HR_RE.test(rawLine) || TABLE_SEP_RE.test(rawLine)) continue;
    // Reference-link definitions are addressing, not prose.
    if (REF_DEF_RE.test(rawLine)) continue;

    // 3. Leading block markers, repeatedly: `> - [ ] task` is all three.
    let line = rawLine;
    for (;;) {
      const before = line;
      if (HEADING_RE.test(line)) line = line.replace(HEADING_RE, '').replace(HEADING_TRAIL_RE, '');
      line = line.replace(BLOCKQUOTE_RE, '');
      line = line.replace(LIST_RE, '');
      line = line.replace(TASK_BOX_RE, '');
      if (line === before) break;
    }

    // 4. Table cells become space-separated columns.
    if (line.includes('|')) line = line.replace(/\|/g, ' ');

    // 5. Inline markup — per line, and only for lines of plausible length
    //    (A-002). Block-level transforms above are single-anchored and
    //    stay unconditional.
    out.push(line.length > MAX_INLINE_LINE_CHARS ? line : stripInline(line));
  }

  return out.join('\n');
}

/**
 * Inline markup → its visible text. Order matters; see DEC-007.
 *
 * Every rule here is **linear in line length by construction** (A-002 /
 * DEC-012), and that is a contract, not an optimization:
 *
 *   1. A class that scans to a closer also excludes its OPENER, so a scan
 *      can never swallow a new opener and always ends at the next one.
 *      `\[([^\]]+)\]` scanned past every `[`, which made `[`×n + `]`×n
 *      cost O(n²) — 22 s on a 200 KB line, and derivation runs inside
 *      `runGen`, so under `cambium serve` that blocks every in-flight run.
 *   2. Emphasis content excludes its own delimiter instead of scanning
 *      lazily (`.*?`), which is the same trap in another shape.
 *
 * The cost is that nested same-delimiter emphasis (`*a **b** c*`) is no
 * longer unwrapped. That is deliberate: the raw haystack still covers a
 * quote of the literal markup (DEC-005), and the deriver only ever has to
 * ADD matches. Adding a rule here means re-checking both properties.
 *
 * A-003 (AUD-001): a rule that REMOVES markup emits a single space, never
 * the empty string. Removing with `''` fuses the tokens on either side
 * into one that exists in neither the source nor its rendering — `12<br>34`
 * became `1234`, and a model hallucinating the amount `1234` then verified
 * as grounded. The space costs nothing (the matcher collapses `\s+` before
 * comparing, so every probe row stays green) and it is what `<br>`, `<li>`
 * and a struck span actually render as: a break, not a join.
 */
function stripInline(line: string): string {
  let s = line;
  s = s.replace(/!\[([^[\]]*)\]\(([^()\s]*)\)/g, '$1');     // image → alt
  s = s.replace(/\[([^[\]]+)\]\(([^()\s]*)\)/g, '$1');      // inline link → text
  s = s.replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, '$1');         // reference link → text
  s = s.replace(/<(https?:\/\/[^<>\s]+)>/g, '$1');          // autolink → url
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, ' ');               // inline HTML tags → separator
  s = s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m]);
  // A-001: struck text is RETRACTED content, so it leaves the reading
  // entirely — `Rollback ~~is~~ was completed` reads as `Rollback was
  // completed`. Unwrapping it would produce a sentence that appears in
  // neither the source nor its rendering, which can only add false
  // positives. A model that quotes the literal `~~is~~` still passes via
  // the raw haystack (DEC-005).
  s = s.replace(/~~([^~]+)~~/g, ' ');                       // strikethrough (dropped) → separator
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');                   // bold
  s = s.replace(/__([^_]+)__/g, '$1');                      // bold (underscore)
  s = s.replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1');      // italic
  // Underscore italic only when the delimiters bound whole words, so
  // `max_tokens` and `snake_case_names` survive intact.
  s = s.replace(/(^|[\s(])_([^_\s](?:[^_]*[^_\s])?)_(?=$|[\s).,;:!?])/g, '$1$2');
  s = s.replace(/`([^`]+)`/g, '$1');                        // inline code
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');      // backslash escapes
  return s;
}

// ── JSON ──────────────────────────────────────────────────────────────

/**
 * JSON → a decoded, pretty haystack. Parses a string source (or takes an
 * already-structured value as-is), then re-renders it with string
 * contents *unescaped* between quotes: `\n` becomes a newline, `\"` a
 * quote, `ü` a `ü`. Keys keep their `"key": value` adjacency, so a
 * quote lifted from a compact source still matches a pretty one and
 * vice versa.
 *
 * The output is deliberately not valid JSON — it is a haystack, not a
 * document. Unparseable input returns `undefined` (raw-only
 * verification), never a run failure.
 */
export function jsonToText(value: unknown): string | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  try {
    return renderJsonValue(parsed, '');
  } catch {
    // Defensive: a cyclic structured context value would recurse forever.
    return undefined;
  }
}

function renderJsonValue(v: unknown, indent: string): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') {
    return JSON.stringify(v) as string;
  }
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((e) => inner + renderJsonValue(e, inner));
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, val]) => `${inner}"${k}": ${renderJsonValue(val, inner)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v) ?? '';
}
