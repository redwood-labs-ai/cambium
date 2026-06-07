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
});
