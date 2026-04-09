import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';
import { execute as calc } from '../tools/calculator.js';

/**
 * Math corrector: walks the output looking for aggregate fields
 * (e.g., avg_* alongside *_samples) and recomputes them deterministically.
 */
export const math: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);

  // Recompute aggregates from samples. This is pure math — no document parsing.
  walkAndCorrect(output, '', issues);

  return {
    corrected: issues.some(i => i.severity === 'fixed'),
    output,
    issues,
  };
};

function walkAndCorrect(obj: any, basePath: string, issues: CorrectorIssue[]): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCorrect(obj[i], `${basePath}[${i}]`, issues);
    }
    return;
  }

  const keys = Object.keys(obj);

  // Look for patterns: *_samples (array of numbers) alongside avg_*, sum_*, min_*, max_*
  for (const k of keys) {
    if (!k.endsWith('_samples') || !Array.isArray(obj[k])) continue;
    const nums = obj[k].filter((v: any) => typeof v === 'number');
    if (!nums.length) continue;

    const prefix = k.replace(/_samples$/, '');
    const aggregates: [string, string][] = [
      [`avg_${prefix}`, 'avg'],
      [`${prefix}_avg`, 'avg'],
      [`sum_${prefix}`, 'sum'],
      [`${prefix}_sum`, 'sum'],
      [`min_${prefix}`, 'min'],
      [`${prefix}_min`, 'min'],
      [`max_${prefix}`, 'max'],
      [`${prefix}_max`, 'max'],
    ];

    for (const [field, op] of aggregates) {
      if (!(field in obj)) continue;
      const expected = calc({ operation: op, operands: nums }).value;
      const actual = obj[field];
      if (actual !== expected) {
        issues.push({
          path: `${basePath}.${field}`,
          message: `${op}(${k}) was ${actual}, recomputed to ${expected}`,
          severity: 'fixed',
          original: actual,
          corrected: expected,
        });
        obj[field] = expected;
      }
    }
  }

  // Recurse into nested objects
  for (const k of keys) {
    walkAndCorrect(obj[k], `${basePath}.${k}`, issues);
  }
}
