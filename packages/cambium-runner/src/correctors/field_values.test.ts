import { describe, it, expect } from 'vitest';
import { fieldValues } from './field_values.js';

const doc = `
Invoice #12345
From: Acme Corp
To: Redwood Labs
Date: 2026-05-28
Subtotal: $1,234.56
Tax: $123.46
Total: $1,357.02
`;

describe('field-values corrector', () => {
  it('passes when all values exist in document', () => {
    const result = fieldValues(
      { vendor: 'Acme Corp', total: '$1,357.02', invoice_no: '12345' },
      { document: doc },
    );
    const fv = result.meta?.fieldValuesResult;
    expect(fv.allValid).toBe(true);
    expect(fv.passed.length).toBe(3);
    expect(fv.failed.length).toBe(0);
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('fails when a value is not in the document', () => {
    const result = fieldValues(
      { vendor: 'Acme Corp', total: '$999.99' },
      { document: doc },
    );
    expect(result.meta?.fieldValuesResult.allValid).toBe(false);
    expect(result.meta?.fieldValuesResult.failed).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].path).toBe('total');
  });

  it('skips null/undefined/boolean values', () => {
    const result = fieldValues(
      { vendor: 'Acme', active: true, count: null, missing: undefined },
      { document: doc },
    );
    const skipped = result.meta?.fieldValuesResult.skipped ?? [];
    expect(skipped.map((s: any) => s.path).sort()).toEqual(['active', 'count', 'missing']);
  });

  it('skips citations fields (verified by citations corrector)', () => {
    const result = fieldValues(
      { vendor: 'Acme Corp', citations: [{ quote: 'xyz', doc_id: 'd' }] },
      { document: doc },
    );
    const skipped = result.meta?.fieldValuesResult.skipped ?? [];
    expect(skipped.some((s: any) => s.path === 'citations')).toBe(true);
  });

  it('recurses into nested objects', () => {
    const result = fieldValues(
      { billing: { vendor: 'Acme Corp', subtotal: '$1,234.56' } },
      { document: doc },
    );
    const fv = result.meta?.fieldValuesResult;
    expect(fv.allValid).toBe(true);
    expect(fv.passed.length).toBe(2);
  });

  it('recurses into arrays', () => {
    const result = fieldValues(
      { items: [{ name: 'Acme Corp' }, { name: 'Nonexistent Vendor' }] },
      { document: doc },
    );
    const fv = result.meta?.fieldValuesResult;
    expect(fv.allValid).toBe(false);
    expect(fv.passed.length).toBe(1);
    expect(fv.failed.length).toBe(1);
  });

  it('handles numeric formatting variations (commas, currency)', () => {
    const result = fieldValues(
      { amount: '1234.56' },  // doc has "$1,234.56" — should match after stripping
      { document: doc },
    );
    expect(result.meta?.fieldValuesResult.allValid).toBe(true);
  });

  it('empty document fails all checks', () => {
    const result = fieldValues(
      { vendor: 'Acme' },
      { document: '' },
    );
    expect(result.meta?.fieldValuesResult.allValid).toBe(false);
    expect(result.meta?.fieldValuesResult.failed).toHaveLength(1);
  });

  it('skips values shorter than 3 characters (DEC-004)', () => {
    const result = fieldValues(
      { code: 'US', amount: '5', ref: 'ab' },
      { document: doc },
    );
    const skipped = result.meta?.fieldValuesResult.skipped ?? [];
    const shortSkips = skipped.filter((s: any) => s.reason === 'too short for reliable match');
    expect(shortSkips.map((s: any) => s.path).sort()).toEqual(['amount', 'code', 'ref']);
    expect(result.meta?.fieldValuesResult.totalChecked).toBe(0);
  });

  it('checks values of exactly 3 characters (DEC-004 boundary)', () => {
    const result = fieldValues(
      { code: 'Acm' },
      { document: doc },
    );
    // 'Acm' is 3 chars — should be checked (not skipped), but not in the doc
    const skipped = result.meta?.fieldValuesResult.skipped ?? [];
    expect(skipped.some((s: any) => s.reason === 'too short for reliable match')).toBe(false);
    expect(result.meta?.fieldValuesResult.totalChecked).toBe(1);
  });

  it('measures the length guard on the trimmed value (AUD-004)', () => {
    const result = fieldValues(
      // raw length 3 but only 1 non-whitespace char — must skip, not check,
      // since the matcher would normalize "  x" to a 1-char substring search.
      { padded: '  x', spaced: ' ab ' },
      { document: doc },
    );
    const skipped = result.meta?.fieldValuesResult.skipped ?? [];
    const shortSkips = skipped.filter((s: any) => s.reason === 'too short for reliable match');
    expect(shortSkips.map((s: any) => s.path).sort()).toEqual(['padded', 'spaced']);
    expect(result.meta?.fieldValuesResult.totalChecked).toBe(0);
  });

  it('skips top-level keys not in fields allowlist (DEC-006)', () => {
    const result = fieldValues(
      { vendor: 'Acme Corp', total: '$1,357.02', invoice_no: '12345' },
      { document: doc, fields: ['vendor'] },
    );
    const fv = result.meta?.fieldValuesResult;
    expect(fv.passed.length).toBe(1);
    expect(fv.passed[0].path).toBe('vendor');
    const skipped = fv.skipped.map((s: any) => s.path).sort();
    expect(skipped).toContain('total');
    expect(skipped).toContain('invoice_no');
    const totalSkip = fv.skipped.find((s: any) => s.path === 'total');
    expect(totalSkip?.reason).toBe('not in fields allowlist');
  });

  it('fields allowlist does not filter nested keys (DEC-006 top-level only)', () => {
    const result = fieldValues(
      { billing: { vendor: 'Acme Corp', subtotal: '$1,234.56' } },
      { document: doc, fields: ['billing'] },
    );
    const fv = result.meta?.fieldValuesResult;
    // 'billing' passes the allowlist; both nested leaves are checked
    expect(fv.passed.length).toBe(2);
    expect(fv.allValid).toBe(true);
  });

  it('ignores fields allowlist when fields is empty array (DEC-006)', () => {
    const result = fieldValues(
      { vendor: 'Acme Corp', total: '$1,357.02' },
      { document: doc, fields: [] },
    );
    const fv = result.meta?.fieldValuesResult;
    // Empty array → no filter applied
    expect(fv.passed.length).toBe(2);
  });

  // ── #169: any-of over document + derivedDocument ────────────────────
  describe('derivedDocument (#169)', () => {
    // A compact JSON source: the escaped value is what the model read as
    // `Restarted twice. Still "flapping".`
    const rawJson = '{"vendor":"Acme Corp","note":"Restarted twice.\\nStill \\"flapping\\"."}';
    const derivedJson = '{\n  "vendor": "Acme Corp",\n  "note": "Restarted twice.\nStill "flapping"."\n}';

    it('passes via the derived view when the raw document misses', () => {
      const output = { note: 'Restarted twice.\nStill "flapping".' };
      expect(fieldValues(output, { document: rawJson }).meta?.fieldValuesResult.allValid).toBe(false);

      const result = fieldValues(output, { document: rawJson, derivedDocument: derivedJson });
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(true);
      expect(fv.passed[0].matched_via).toBe('derived');
      expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    });

    it('reports document when the raw text hits, even though derived would too', () => {
      const result = fieldValues(
        { vendor: 'Acme Corp' },
        { document: rawJson, derivedDocument: derivedJson },
      );
      expect(result.meta?.fieldValuesResult.passed[0].matched_via).toBe('document');
    });

    it('still fails a value that is in neither haystack', () => {
      const result = fieldValues(
        { vendor: 'Globex Industries' },
        { document: rawJson, derivedDocument: derivedJson },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(false);
      expect(fv.failed[0].reason).toBe('value not found in grounding document');
    });

    it('reports document when derivedDocument is absent (unchanged behavior)', () => {
      const result = fieldValues({ vendor: 'Acme Corp' }, { document: doc });
      expect(result.meta?.fieldValuesResult.passed[0].matched_via).toBe('document');
    });

    it('checks nested leaves against the derived view too', () => {
      const result = fieldValues(
        { incident: { note: 'Restarted twice.\nStill "flapping".' } },
        { document: rawJson, derivedDocument: derivedJson },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.totalChecked).toBe(1);
      expect(fv.passed[0].path).toBe('incident.note');
      expect(fv.passed[0].matched_via).toBe('derived');
    });
  });

  describe('scale-stated numbers (#274 Part 2)', () => {
    // The three rows from #274's evidence table: the model stated the scale,
    // the filing declared it in a header and printed the number bare.
    const filing = `
ACME CORP CONSOLIDATED STATEMENTS OF OPERATIONS
(in millions, except per share amounts)

Revenue $13,769
Net revenues $11,040

Segment detail — Revenues ($ millions)
Cloud 169.3
`;

    it('accepts a value that states the scale the document declares in a header', () => {
      const result = fieldValues(
        { revenue: '$13,769 million', net: '$11,040M', cloud: '$169.3M' },
        { document: filing },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(true);
      expect(fv.passed).toHaveLength(3);
      expect(result.issues.filter((i: any) => i.severity === 'error')).toHaveLength(0);
    });

    it('still fails a scale-stated number that is absent (the check keeps its teeth)', () => {
      const result = fieldValues({ revenue: '$99,999 million' }, { document: filing });
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(false);
      expect(fv.failed).toHaveLength(1);
    });

    it('does not relax a range — out of scope for a substring matcher (#274)', () => {
      // Row 4 of the evidence table. `fields:` or the semantic strategy is the
      // answer here; silently half-matching one endpoint would be worse.
      const result = fieldValues(
        { guidance: '$1,150 million to $1,200 million' },
        { document: 'Guidance: between $1,150 million and $1,200 million' },
      );
      expect(result.meta?.fieldValuesResult.allValid).toBe(false);
    });

    it('does not relax a 1-2 digit number — "$1M" would match on noise', () => {
      const result = fieldValues(
        { small: '$1M', tiny: '$12M' },
        { document: 'Section 1 of 12 pages. Revenue was strong.' },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(false);
      expect(fv.failed).toHaveLength(2);
    });

    it('does not strip a trailing letter from an alphanumeric identifier', () => {
      // Dropping the `B` would match part number AB-1234A — a different part.
      const result = fieldValues(
        { part: 'AB-1234B' },
        { document: 'Bill of materials: AB-1234A, qty 3' },
      );
      expect(result.meta?.fieldValuesResult.allValid).toBe(false);
    });

    it('relaxes against the derived view too (#169 any-of is preserved)', () => {
      const result = fieldValues(
        { revenue: '$13,769 million' },
        {
          document: '| Revenue | **$13,769** |',
          derivedDocument: 'Revenue $13,769',
        },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(true);
      expect(fv.passed[0].matched_via).toBe('document');
    });

    it('a verbatim scale-stated value still reports a plain exact match', () => {
      // The fallback runs last, so nothing that passed before #274 changes.
      const result = fieldValues(
        { revenue: '$13,769 million' },
        { document: 'Revenue of $13,769 million for the year' },
      );
      const fv = result.meta?.fieldValuesResult;
      expect(fv.allValid).toBe(true);
      expect(fv.passed[0].matched_via).toBe('document');
    });
  });
});
