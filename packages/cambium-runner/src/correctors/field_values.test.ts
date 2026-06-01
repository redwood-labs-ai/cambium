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
});
