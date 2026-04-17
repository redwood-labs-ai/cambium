import { describe, it, expect } from 'vitest';

// Inline the normalize function to test it in isolation
function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
}

describe('GAIA eval — answer normalization', () => {
  it('normalizes numeric answers', () => {
    expect(normalizeAnswer('42')).toBe('42');
    expect(normalizeAnswer(' 42 ')).toBe('42');
    expect(normalizeAnswer('42.0')).toBe('42.0');
  });

  it('normalizes text answers', () => {
    expect(normalizeAnswer('Au')).toBe('au');
    expect(normalizeAnswer('  Au  ')).toBe('au');
    expect(normalizeAnswer('Paris.')).toBe('paris');
  });

  it('normalizes answers with punctuation', () => {
    expect(normalizeAnswer('"48"')).toBe('48');
    expect(normalizeAnswer("'Au'")).toBe('au');
    expect(normalizeAnswer('150 km')).toBe('150 km');
  });

  it('collapses whitespace', () => {
    expect(normalizeAnswer('hello   world')).toBe('hello world');
    expect(normalizeAnswer('  366  days  ')).toBe('366 days');
  });

  it('treats equivalent answers as matching', () => {
    expect(normalizeAnswer('48')).toBe(normalizeAnswer(' 48 '));
    expect(normalizeAnswer('Au')).toBe(normalizeAnswer('"au"'));
    expect(normalizeAnswer('150.')).toBe(normalizeAnswer('150'));
  });
});

describe('GAIA eval — summary computation', () => {
  it('computes accuracy correctly', () => {
    const results = [
      { correct: true },
      { correct: false },
      { correct: true },
      { correct: true },
    ];
    const correct = results.filter(r => r.correct).length;
    const accuracy = Math.round((correct / results.length) * 1000) / 10;
    expect(accuracy).toBe(75);
  });

  it('handles empty results', () => {
    const results: { correct: boolean }[] = [];
    const correct = results.filter(r => r.correct).length;
    const total = results.length;
    expect(correct).toBe(0);
    expect(total).toBe(0);
  });
});
