/**
 * #169: the format-aware derived view, probed with the real matcher.
 *
 * The two tables below are the probe tables from the issue body,
 * transcribed verbatim. Each row is checked TWICE against the shipped
 * `citations` corrector: once with the raw source as the haystack
 * (`before` — today's behavior, and what the raw-first branch of the
 * any-of still covers) and once with the derived view (`after`). A row
 * marked `before: 'fail'` is a correct quote that current main reports
 * as fabricated.
 */
import { describe, it, expect } from 'vitest';
import { deriveGroundingText, markdownToText, jsonToText } from './grounding-text.js';
import { citations } from './correctors/citations.js';
import { fieldValues } from './correctors/field_values.js';

/** Does the shipped citation matcher find `quote` in `document`? */
function verifies(document: string, quote: string): boolean {
  const result = citations({ citations: [{ quote }] }, { document });
  return result.meta?.citationResult?.allValid === true;
}

/**
 * The production wiring: raw document first, derived view second (DEC-005).
 * Use this rather than the deriver's output string whenever the question is
 * "would this quote verify?", because the matcher — not the deriver — owns
 * whitespace normalization.
 */
function verifiesAnyOf(raw: string, quote: string): boolean {
  const result = citations(
    { citations: [{ quote }] },
    { document: raw, derivedDocument: markdownToText(raw) },
  );
  return result.meta?.citationResult?.allValid === true;
}

/** Whitespace-insensitive comparison — the matcher collapses `\s+` anyway. */
const collapsed = (text: string) => text.replace(/\s+/g, ' ').trim();

type Row = { construct: string; source: string; quote: string; before: 'pass' | 'fail' };

// ── Markdown probe table (issue #169) ─────────────────────────────────
const MARKDOWN_ROWS: Row[] = [
  { construct: 'heading', source: '## Q3 revenue summary', quote: 'Q3 revenue summary', before: 'pass' },
  { construct: 'list item', source: '- Rolled back the deploy', quote: 'Rolled back the deploy', before: 'pass' },
  { construct: 'blockquote', source: '> The incident began at 09:14', quote: 'The incident began at 09:14', before: 'pass' },
  { construct: 'task list', source: '- [x] Ship the hotfix', quote: 'Ship the hotfix', before: 'pass' },
  { construct: 'soft-wrapped paragraph', source: 'Latency climbed steadily\nthrough the afternoon', quote: 'Latency climbed steadily through the afternoon', before: 'pass' },
  { construct: 'fenced-code content', source: '```sh\nsystemctl restart nginx\n```', quote: 'systemctl restart nginx', before: 'pass' },
  { construct: 'bold', source: 'Revenue grew **12%** in Q3', quote: 'Revenue grew 12% in Q3', before: 'fail' },
  { construct: 'italic (underscore)', source: 'This is _critical_ for uptime', quote: 'This is critical for uptime', before: 'fail' },
  { construct: 'strikethrough', source: 'Rollback ~~is~~ was completed', quote: 'Rollback was completed', before: 'fail' },
  { construct: 'inline code', source: 'Run `omarchy theme set` to apply', quote: 'Run omarchy theme set to apply', before: 'fail' },
  { construct: 'inline link', source: 'See the [quarterly report](https://example.com/q3) for details', quote: 'See the quarterly report for details', before: 'fail' },
  { construct: 'reference link', source: 'Read the [runbook][1] now', quote: 'Read the runbook now', before: 'fail' },
  { construct: 'image alt', source: 'See ![dashboard](img.png) for the spike', quote: 'See dashboard for the spike', before: 'fail' },
  { construct: 'table row', source: '| libfoo | 1.2.3 |', quote: 'libfoo 1.2.3', before: 'fail' },
  { construct: 'backslash escape', source: 'Use 2\\*3 for the product', quote: 'Use 2*3 for the product', before: 'fail' },
  { construct: 'inline HTML', source: 'Status: <kbd>degraded</kbd> since noon', quote: 'Status: degraded since noon', before: 'fail' },
];

// ── JSON probe table (issue #169) ─────────────────────────────────────
const PRETTY = '{\n  "vendor": "Acme",\n  "total": 1200,\n  "tags": [\n    "urgent",\n    "billing"\n  ]\n}';
const JSON_ROWS: Row[] = [
  { construct: 'bare string value', source: PRETTY, quote: 'Acme', before: 'pass' },
  { construct: 'number', source: PRETTY, quote: '1200', before: 'pass' },
  { construct: '"key": "value" (pretty source)', source: PRETTY, quote: '"vendor": "Acme"', before: 'pass' },
  { construct: 'array item (pretty source)', source: PRETTY, quote: 'billing', before: 'pass' },
  { construct: 'compact source vs pretty-printed quote', source: '{"status":"degraded","since":"noon"}', quote: '"status": "degraded"', before: 'fail' },
  { construct: 'escaped newline in a string value', source: '{"note":"Restarted twice.\\nStill \\"flapping\\"."}', quote: 'Restarted twice.\nStill "flapping".', before: 'fail' },
  { construct: 'escaped quote in a string value', source: '{"note":"Restarted twice.\\nStill \\"flapping\\"."}', quote: 'Still "flapping"', before: 'fail' },
  { construct: '\\uXXXX escape', source: '{"city":"Z\\u00fcrich"}', quote: 'Zürich', before: 'fail' },
];

describe('#169 probe table — Markdown', () => {
  it.each(MARKDOWN_ROWS)('$construct: raw verifies = $before', ({ source, quote, before }) => {
    expect(verifies(source, quote)).toBe(before === 'pass');
  });

  it.each(MARKDOWN_ROWS)('$construct: derived verifies', ({ source, quote }) => {
    expect(verifies(markdownToText(source), quote)).toBe(true);
  });
});

describe('#169 probe table — JSON', () => {
  it.each(JSON_ROWS)('$construct: raw verifies = $before', ({ source, quote, before }) => {
    expect(verifies(source, quote)).toBe(before === 'pass');
  });

  it.each(JSON_ROWS)('$construct: derived verifies', ({ source, quote }) => {
    const derived = jsonToText(source);
    expect(derived).toBeDefined();
    expect(verifies(derived!, quote)).toBe(true);
  });
});

describe('markdownToText', () => {
  it('leaves snake_case identifiers alone', () => {
    expect(markdownToText('Set max_tokens and per_run_budget in the config'))
      .toBe('Set max_tokens and per_run_budget in the config');
  });

  it('still unwraps underscore italics that delimit whole words', () => {
    expect(markdownToText('This is _critical_ for uptime')).toBe('This is critical for uptime');
    expect(markdownToText('(_note_) and _end_.')).toBe('(note) and end.');
  });

  it('emits fenced-code lines verbatim, markup and all', () => {
    const md = '```py\nx = a * b * c\ny = _leading\n```';
    expect(markdownToText(md)).toBe('x = a * b * c\ny = _leading');
  });

  it('unescapes backslash escapes', () => {
    expect(markdownToText('Use 2\\*3 for the product')).toBe('Use 2*3 for the product');
  });

  it('drops struck-through text, content and all (A-001)', () => {
    // A-003: the span is replaced by a separator, not deleted. Spacing is
    // not load-bearing — the matcher collapses it — so compare collapsed.
    expect(collapsed(markdownToText('Rollback ~~is~~ was completed'))).toBe('Rollback was completed');
  });

  it('leaves a quote of the literal ~~markup~~ to the raw haystack (DEC-005)', () => {
    const source = 'Rollback ~~is~~ was completed';
    const result = citations(
      { citations: [{ quote: source }] },
      { document: source, derivedDocument: markdownToText(source) },
    );
    const cit = result.meta?.citationResult;
    expect(cit.allValid).toBe(true);
    expect(cit.passed[0].matched_via).toBe('document');
  });

  it('strips nested block markers in one pass', () => {
    expect(markdownToText('> - [ ] Draft the postmortem')).toBe('Draft the postmortem');
  });

  it('strips inline HTML tags and decodes entities', () => {
    expect(collapsed(markdownToText('Status: <kbd>degraded</kbd> since noon'))).toBe('Status: degraded since noon');
    expect(markdownToText('Tom &amp; Jerry &lt;tag&gt; &quot;quoted&quot; &nbsp;here'))
      .toBe('Tom & Jerry <tag> "quoted"  here');
  });

  it('does not double-decode entities', () => {
    expect(markdownToText('Literal &amp;lt; entity')).toBe('Literal &lt; entity');
  });

  it('turns table rows into space-separated columns and drops the separator', () => {
    const md = '| package | version |\n|---------|---------|\n| libfoo  | 1.2.3   |';
    const cells = markdownToText(md).split('\n').map((l) => l.trim().replace(/\s+/g, ' '));
    expect(cells).toEqual(['package version', 'libfoo 1.2.3']);
  });

  it('drops horizontal rules and reference-link definitions', () => {
    expect(markdownToText('Alpha\n\n---\n\n[1]: https://example.com/runbook\n\nBeta'))
      .toBe('Alpha\n\n\n\nBeta');
  });

  it('unwraps autolinks to their URL', () => {
    expect(markdownToText('Docs at <https://example.com/x> today'))
      .toBe('Docs at https://example.com/x today');
  });

  it('keeps front matter (its text is citable and passes today)', () => {
    const md = '---\ntitle: Release notes\n---\n\nBody';
    // The `---` delimiters are horizontal rules and drop out; the text stays.
    expect(markdownToText(md)).toContain('title: Release notes');
  });

  it('is a no-op on plain prose', () => {
    const plain = 'Nothing here is marked up at all.';
    expect(markdownToText(plain)).toBe(plain);
  });
});

// ── A-003 / AUD-001: removals must not fuse adjacent tokens ───────────
//
// A rule that deletes markup manufactures a token that appears in neither
// the source nor its rendering, and a model hallucinating that token then
// verifies as grounded — the exact failure grounding exists to catch. The
// line between the two halves of this battery is what a real renderer
// shows: `<br>` and `<li>` are breaks, a struck span is retracted, but
// emphasis and code spans genuinely join the characters around them.
describe('#169 fusion battery (A-003)', () => {
  const FUSED: Array<[string, string]> = [
    ['Total: 12<br>34 units', '1234'],
    ['Charge 12~~00~~34 dollars', '1234'],
    ['The contractor was un~~der~~paid.', 'unpaid'],
    ['<li>Alpha</li><li>Beta</li>', 'AlphaBeta'],
  ];

  it.each(FUSED)('%s does not manufacture %s', (source, quote) => {
    expect(verifiesAnyOf(source, quote)).toBe(false);
  });

  const LEGITIMATE: Array<[string, string]> = [
    ['The cluster runs 2*3*4 shards.', '234'],
    ['ids 1**2**3 here', '123'],
    ['Values a`12`b here', 'a12b'],
  ];

  it.each(LEGITIMATE)('%s still verifies %s (a renderer joins these)', (source, quote) => {
    expect(verifiesAnyOf(source, quote)).toBe(true);
  });

  it('is the field-values matcher too — a fabricated amount stays ungrounded', () => {
    const doc = '| Line | Amount |\n|------|--------|\n| Hosting | 12<br>34 |';
    const result = fieldValues(
      { amount: 1234 },
      { document: doc, derivedDocument: markdownToText(doc) },
    );
    const fv = result.meta?.fieldValuesResult;
    expect(fv.allValid).toBe(false);
    expect(fv.failed[0].reason).toBe('value not found in grounding document');
  });
});

describe('jsonToText', () => {
  it('derives identical text from compact and pretty sources', () => {
    const compact = '{"vendor":"Acme","total":1200,"tags":["urgent","billing"]}';
    expect(jsonToText(compact)).toBe(jsonToText(PRETTY));
  });

  it('takes an already-structured value directly (pipeline bind())', () => {
    expect(jsonToText({ vendor: 'Acme', total: 1200, tags: ['urgent', 'billing'] }))
      .toBe(jsonToText('{"vendor":"Acme","total":1200,"tags":["urgent","billing"]}'));
  });

  it('emits string contents unescaped between quotes', () => {
    expect(jsonToText('{"note":"line one\\nline \\"two\\""}'))
      .toBe('{\n  "note": "line one\nline "two""\n}');
  });

  it('decodes \\uXXXX escapes', () => {
    expect(jsonToText('{"city":"Z\\u00fcrich"}')).toBe('{\n  "city": "Zürich"\n}');
  });

  it('renders numbers, booleans and null via JSON.stringify', () => {
    expect(jsonToText('{"n":1.5,"b":true,"z":null}'))
      .toBe('{\n  "n": 1.5,\n  "b": true,\n  "z": null\n}');
  });

  it('renders empty containers inline', () => {
    expect(jsonToText('{"a":[],"b":{}}')).toBe('{\n  "a": [],\n  "b": {}\n}');
  });

  it('puts one array element per line', () => {
    expect(jsonToText('["a","b"]')).toBe('[\n  "a",\n  "b"\n]');
  });

  it('returns undefined for unparseable JSON (never a failure)', () => {
    expect(jsonToText('{not json at all')).toBeUndefined();
    expect(jsonToText('')).toBeUndefined();
  });

  it('returns undefined for a cyclic structured value', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(jsonToText(cyclic)).toBeUndefined();
  });
});

describe('deriveGroundingText', () => {
  it('derives for markdown and json', () => {
    expect(deriveGroundingText('markdown', 'Revenue grew **12%**')).toBe('Revenue grew 12%');
    expect(deriveGroundingText('json', '{"a":"b"}')).toBe('{\n  "a": "b"\n}');
  });

  it('returns undefined for text, unknown formats, and empty documents', () => {
    expect(deriveGroundingText('text', 'Revenue grew **12%**')).toBeUndefined();
    expect(deriveGroundingText('csv', 'a,b')).toBeUndefined();
    expect(deriveGroundingText('markdown', '')).toBeUndefined();
  });

  it('returns undefined for null, undefined, and non-string scalars', () => {
    expect(deriveGroundingText('markdown', null)).toBeUndefined();
    expect(deriveGroundingText('markdown', undefined)).toBeUndefined();
    expect(deriveGroundingText('json', 42)).toBeUndefined();
    expect(deriveGroundingText('json', true)).toBeUndefined();
  });

  it('returns undefined for a document envelope', () => {
    const envelope = { kind: 'base64_pdf', data: 'JVBERi0=', media_type: 'application/pdf' };
    expect(deriveGroundingText('markdown', envelope)).toBeUndefined();
    expect(deriveGroundingText('json', envelope)).toBeUndefined();
  });

  it('returns undefined for a structured value under markdown', () => {
    expect(deriveGroundingText('markdown', { a: 1 })).toBeUndefined();
  });

  it('returns undefined for unparseable JSON', () => {
    expect(deriveGroundingText('json', 'not json')).toBeUndefined();
  });

  it('is deterministic — same input, same output', () => {
    const md = '# Title\n\n- **bold** and [link](https://x)\n';
    expect(deriveGroundingText('markdown', md)).toBe(deriveGroundingText('markdown', md));
  });
});
