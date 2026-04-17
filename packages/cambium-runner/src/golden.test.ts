import { describe, it, expect } from 'vitest';
import {
  goldenTest,
  stripCitations,
  normalizeNumbers,
  normalizeStrings,
  normalizeDates,
  formatGoldenFailure,
} from './golden.js';

describe('goldenTest', () => {
  it('passes when actual matches expected exactly', () => {
    const result = goldenTest({ answer: '42' }, { answer: '42' });
    expect(result.passed).toBe(true);
    expect(result.diffs).toHaveLength(0);
  });

  it('detects missing fields', () => {
    const result = goldenTest({ answer: '42' }, { answer: '42', reasoning: 'because' });
    expect(result.passed).toBe(false);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe('reasoning');
    expect(result.diffs[0].type).toBe('missing');
  });

  it('detects extra fields', () => {
    const result = goldenTest({ answer: '42', extra: true }, { answer: '42' });
    expect(result.passed).toBe(false);
    expect(result.diffs[0].type).toBe('extra');
  });

  it('detects changed values', () => {
    const result = goldenTest({ answer: '42' }, { answer: '43' });
    expect(result.passed).toBe(false);
    expect(result.diffs[0].type).toBe('changed');
  });

  it('handles nested objects', () => {
    const result = goldenTest(
      { data: { items: [{ name: 'a' }] } },
      { data: { items: [{ name: 'b' }] } },
    );
    expect(result.passed).toBe(false);
    expect(result.diffs[0].path).toBe('data.items[0].name');
  });

  it('supports supersetOnly mode', () => {
    const result = goldenTest(
      { answer: '42', reasoning: 'math', extra: true },
      { answer: '42' },
      { supersetOnly: true },
    );
    expect(result.passed).toBe(true);
  });

  it('supports number tolerance', () => {
    const result = goldenTest({ value: 3.141 }, { value: 3.14 }, { numberTolerance: 0.01 });
    expect(result.passed).toBe(true);
  });

  it('fails when numbers exceed tolerance', () => {
    const result = goldenTest({ value: 3.2 }, { value: 3.14 }, { numberTolerance: 0.01 });
    expect(result.passed).toBe(false);
  });

  it('supports ignoreFields', () => {
    const result = goldenTest(
      { answer: '42', timestamp: '2026-04-14T12:00:00Z' },
      { answer: '42', timestamp: '2026-04-14T13:00:00Z' },
      { ignoreFields: ['timestamp'] },
    );
    expect(result.passed).toBe(true);
  });

  it('supports wildcard ignoreFields', () => {
    const result = goldenTest(
      { items: [{ name: 'a', quote: 'different' }] },
      { items: [{ name: 'a', quote: 'expected' }] },
      { ignoreFields: ['items[*].quote'] },
    );
    expect(result.passed).toBe(true);
  });

  it('applies normalizers', () => {
    const result = goldenTest(
      { answer: ' 42 ', reasoning: 'because' },
      { answer: '42', reasoning: 'because' },
      { normalizers: [normalizeStrings] },
    );
    expect(result.passed).toBe(true);
  });

  it('handles null and undefined equivalence', () => {
    const result = goldenTest({ value: null }, { value: undefined });
    expect(result.passed).toBe(true);
  });

  it('handles arrays of different lengths', () => {
    const result = goldenTest(
      { items: ['a', 'b', 'c'] },
      { items: ['a', 'b'] },
    );
    expect(result.passed).toBe(false);
  });
});

describe('stripCitations', () => {
  it('removes citation fields from objects', () => {
    const input = {
      fact: 'Something happened',
      citations: [{ quote: 'text', doc_id: 'd1' }],
    };
    expect(stripCitations(input)).toEqual({ fact: 'Something happened' });
  });

  it('handles nested arrays', () => {
    const input = {
      items: [
        { name: 'a', citations: [{ quote: 'q1' }] },
        { name: 'b', citations: [{ quote: 'q2' }] },
      ],
    };
    expect(stripCitations(input)).toEqual({ items: [{ name: 'a' }, { name: 'b' }] });
  });
});

describe('normalizeNumbers', () => {
  it('rounds numbers to specified precision', () => {
    expect(normalizeNumbers({ value: 3.14159 })).toEqual({ value: 3.14 });
    expect(normalizeNumbers({ value: 3.14159 }, 3)).toEqual({ value: 3.142 });
  });

  it('handles nested structures', () => {
    const input = { items: [{ price: 19.999 }, { price: 5.001 }] };
    expect(normalizeNumbers(input)).toEqual({ items: [{ price: 20 }, { price: 5 }] });
  });
});

describe('normalizeDates', () => {
  it('strips time from ISO dates', () => {
    const input = { created: '2026-04-14T12:00:00Z', name: 'test' };
    expect(normalizeDates(input)).toEqual({ created: '2026-04-14', name: 'test' });
  });
});

describe('formatGoldenFailure', () => {
  it('formats readable error message', () => {
    const result = goldenTest({ answer: '42' }, { answer: '43' });
    const msg = formatGoldenFailure(result, 'analyst test');
    expect(msg).toContain('Golden test failed: analyst test');
    expect(msg).toContain('1 difference(s)');
  });
});
