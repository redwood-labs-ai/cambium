import type { CorrectorFn, CorrectorResult } from './types.js';
import { math } from './math.js';
import { dates } from './dates.js';
import { currency } from './currency.js';

export type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

export const correctors: Record<string, CorrectorFn> = { math, dates, currency };

export function runCorrectorPipeline(
  names: string[],
  data: any,
  context: { document?: string },
): { data: any; results: CorrectorResult[] } {
  const results: CorrectorResult[] = [];
  let current = data;

  for (const name of names) {
    const fn = correctors[name];
    if (!fn) {
      throw new Error(`Unknown corrector: "${name}". Available: ${Object.keys(correctors).join(', ')}`);
    }
    const result = fn(current, context);
    results.push(result);
    if (result.corrected) {
      current = result.output;
    }
  }

  return { data: current, results };
}
