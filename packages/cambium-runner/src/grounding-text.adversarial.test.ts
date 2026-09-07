/**
 * A-002 (DEC-012): the Markdown deriver is linear in input length, and
 * that is a contract.
 *
 * Every rule in `stripInline` scans to a closer whose character class also
 * excludes its opener, so no scan can swallow a new opener. Before A-002,
 * `\[([^\]]+)\]` scanned past every `[`, and these same inputs at n=40k
 * took 4.5 s (`[`×n + `]`×n), 9.0 s (`[x](`×n), 22.4 s (`![x](`×n) and
 * 35.9 s (`<http://`×n) — with the whole thing running synchronously
 * inside `runGen`, so under `cambium serve` one hostile document blocks
 * every in-flight run. Here the inputs are an order of magnitude larger
 * and the budget is 1 second.
 *
 * Two sizes per construct, deliberately:
 *   - one ~500k-char LINE, which the `MAX_INLINE_LINE_CHARS` cap short-
 *     circuits — this pins the cap;
 *   - ~500k chars of the same content split into just-under-cap lines,
 *     which the inline regexes actually process — this pins the regexes.
 * The second is the one that would still fail on the pre-A-002 rules.
 */
import { describe, it, expect } from 'vitest';
import { markdownToText, jsonToText } from './grounding-text.js';

const BUDGET_MS = 1000;
const CAP = 20_000;

/** Repeat `unit` until the result is at least `chars` long. */
const grow = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

/** [name, repeating unit] — one per "scan to the closer" / emphasis rule. */
const CONSTRUCTS: Array<[string, string]> = [
  ['unclosed openers then closers', '['],   // special-cased below
  ['link opener', '[x]('],
  ['image opener', '![x]('],
  ['reference-link opener', '[x]['],
  ['HTML tag opener', '<a'],
  ['autolink opener', '<http://'],
  ['italic delimiter', '*a '],
  ['underscore italic delimiter', ' _a '],
  ['bold delimiter', '**a '],
  ['strikethrough delimiter', '~~a '],
];

/** The `[`×n + `]`×n shape doesn't come from a repeating unit. */
function bracketStorm(chars: number): string {
  const n = Math.floor(chars / 2);
  return '['.repeat(n) + ']'.repeat(n);
}

function timed(input: string): number {
  const started = performance.now();
  markdownToText(input);
  return performance.now() - started;
}

describe('A-002: markdownToText is linear on adversarial input', () => {
  describe('a single ~500k-char line (the cap short-circuits it)', () => {
    it.each(CONSTRUCTS)('%s', (name, unit) => {
      const input = name === 'unclosed openers then closers' ? bracketStorm(500_000) : grow(unit, 500_000);
      expect(input.length).toBeGreaterThanOrEqual(499_999);
      expect(timed(input)).toBeLessThan(BUDGET_MS);
    });

    it('a lone backtick followed by 500k characters', () => {
      expect(timed(`\`${'a'.repeat(500_000)}`)).toBeLessThan(BUDGET_MS);
    });
  });

  describe('~500k chars of the same content in under-cap lines (the regexes run)', () => {
    // 26 lines just under the cap ≈ 520k chars, every one of them fully
    // transformed. This is the case the pre-A-002 rules could not survive.
    const LINES = 26;
    const lineOf = (unit: string) => grow(unit, CAP - unit.length).slice(0, CAP - 1);

    it.each(CONSTRUCTS)('%s', (name, unit) => {
      const line = name === 'unclosed openers then closers' ? bracketStorm(CAP - 1) : lineOf(unit);
      expect(line.length).toBeLessThan(CAP);
      const input = Array(LINES).fill(line).join('\n');
      expect(input.length).toBeGreaterThan(500_000);
      expect(timed(input)).toBeLessThan(BUDGET_MS);
    });
  });
});

describe('A-002: MAX_INLINE_LINE_CHARS', () => {
  /** A line of exactly `len` characters containing a bold span. */
  const boldLine = (len: number) => {
    const bold = '**x**';
    return 'a'.repeat(len - bold.length) + bold;
  };

  it('transforms a 19,999-character line', () => {
    const line = boldLine(19_999);
    expect(line.length).toBe(19_999);
    expect(markdownToText(line)).toBe(`${'a'.repeat(19_994)}x`);
  });

  it('returns a 20,001-character line verbatim', () => {
    const line = boldLine(20_001);
    expect(line.length).toBe(20_001);
    expect(markdownToText(line)).toBe(line);
  });

  it('caps per line, not per document — short lines around a long one still transform', () => {
    const long = boldLine(20_001);
    const out = markdownToText(`Revenue grew **12%** in Q3\n${long}\nSee _the report_`);
    expect(out).toBe(`Revenue grew 12% in Q3\n${long}\nSee the report`);
  });
});

describe('A-002: jsonToText survives hostile structures', () => {
  it('returns undefined for 100k levels of nesting, without throwing', () => {
    const deep = `${'['.repeat(100_000)}1${']'.repeat(100_000)}`;
    let result: string | undefined;
    expect(() => { result = jsonToText(deep); }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it('returns undefined for a cyclic structured value, without throwing', () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    let result: string | undefined;
    expect(() => { result = jsonToText(cyclic); }).not.toThrow();
    expect(result).toBeUndefined();
  });
});
