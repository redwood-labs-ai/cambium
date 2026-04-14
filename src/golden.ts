/**
 * Golden test framework for LLM programs (RED-140).
 *
 * Compares actual outputs against expected snapshots with field-level diffs
 * and support for tolerances/normalizers (dates, currency, citations).
 *
 * Usage:
 *   import { goldenTest, normalizeForComparison } from './golden.js';
 *
 *   it('analyst produces expected output', () => {
 *     const actual = runAnalyst(fixture);
 *     const expected = loadSnapshot('analyst-snapshot.json');
 *     goldenTest(actual, expected, {
 *       ignoreFields: ['citations[].quote'],
 *       normalizers: [stripCitations, normalizeNumbers],
 *     });
 *   });
 */

export type DiffEntry = {
  path: string;
  type: 'missing' | 'extra' | 'changed' | 'type_mismatch';
  expected?: any;
  actual?: any;
};

export type GoldenTestOptions = {
  /** Fields to ignore during comparison (dot/bracket paths, supports wildcards). */
  ignoreFields?: string[];
  /** Normalizer functions applied to both actual and expected before comparison. */
  normalizers?: Array<(obj: any) => any>;
  /** Tolerance for numeric comparisons (default: 0). */
  numberTolerance?: number;
  /** If true, only check that expected fields exist in actual (superset check). */
  supersetOnly?: boolean;
};

export type GoldenTestResult = {
  passed: boolean;
  diffs: DiffEntry[];
  summary: string;
};

// ── Core comparison ───────────────────────────────────────────────────

export function goldenTest(
  actual: any,
  expected: any,
  options: GoldenTestOptions = {},
): GoldenTestResult {
  // Apply normalizers
  let a = actual;
  let e = expected;
  for (const norm of options.normalizers ?? []) {
    a = norm(structuredClone(a));
    e = norm(structuredClone(e));
  }

  const diffs: DiffEntry[] = [];
  compareValues(a, e, '', diffs, options);

  const passed = diffs.length === 0;
  const summary = passed
    ? 'All fields match'
    : `${diffs.length} difference(s):\n${diffs.map(d => `  ${d.path}: ${d.type} (expected: ${JSON.stringify(d.expected)}, got: ${JSON.stringify(d.actual)})`).join('\n')}`;

  return { passed, diffs, summary };
}

function compareValues(
  actual: any,
  expected: any,
  path: string,
  diffs: DiffEntry[],
  options: GoldenTestOptions,
): void {
  const ignoreFields = options.ignoreFields ?? [];

  // Check if this path should be ignored
  if (ignoreFields.some(pattern => matchesPath(path, pattern))) return;

  // Type mismatch
  if (typeof actual !== typeof expected) {
    // Allow null/undefined equivalence
    if ((actual == null) && (expected == null)) return;
    diffs.push({ path, type: 'type_mismatch', expected, actual });
    return;
  }

  // Primitives
  if (typeof expected !== 'object' || expected === null) {
    if (typeof expected === 'number' && typeof actual === 'number') {
      const tolerance = options.numberTolerance ?? 0;
      if (Math.abs(actual - expected) > tolerance) {
        diffs.push({ path, type: 'changed', expected, actual });
      }
    } else if (actual !== expected) {
      diffs.push({ path, type: 'changed', expected, actual });
    }
    return;
  }

  // Arrays
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push({ path, type: 'type_mismatch', expected: 'array', actual: typeof actual });
      return;
    }
    // Compare array lengths only if not superset mode
    if (!options.supersetOnly && actual.length !== expected.length) {
      diffs.push({ path: `${path}.length`, type: 'changed', expected: expected.length, actual: actual.length });
    }
    // Compare elements up to expected length
    const maxLen = options.supersetOnly ? expected.length : Math.max(actual.length, expected.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= expected.length) {
        if (!options.supersetOnly) {
          diffs.push({ path: `${path}[${i}]`, type: 'extra', actual: actual[i] });
        }
      } else if (i >= actual.length) {
        diffs.push({ path: `${path}[${i}]`, type: 'missing', expected: expected[i] });
      } else {
        compareValues(actual[i], expected[i], `${path}[${i}]`, diffs, options);
      }
    }
    return;
  }

  // Objects
  if (typeof actual !== 'object' || actual === null) {
    diffs.push({ path, type: 'type_mismatch', expected: 'object', actual: typeof actual });
    return;
  }

  const expectedKeys = Object.keys(expected);
  const actualKeys = new Set(Object.keys(actual));

  for (const key of expectedKeys) {
    const childPath = path ? `${path}.${key}` : key;
    if (!actualKeys.has(key)) {
      diffs.push({ path: childPath, type: 'missing', expected: expected[key] });
    } else {
      compareValues(actual[key], expected[key], childPath, diffs, options);
    }
  }

  if (!options.supersetOnly) {
    for (const key of actualKeys) {
      if (!expectedKeys.includes(key)) {
        const childPath = path ? `${path}.${key}` : key;
        diffs.push({ path: childPath, type: 'extra', actual: actual[key] });
      }
    }
  }
}

function matchesPath(path: string, pattern: string): boolean {
  // Simple wildcard matching: citations[*].quote matches citations[0].quote
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\[\*\]/g, '\\[\\d+\\]').replace(/\*/g, '.*') + '$',
  );
  return regex.test(path);
}

// ── Built-in normalizers ──────────────────────────────────────────────

/** Strip citation fields for comparison when citations aren't the focus. */
export function stripCitations(obj: any): any {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripCitations);
  const result: any = {};
  for (const key of Object.keys(obj)) {
    if (key === 'citations') continue;
    result[key] = stripCitations(obj[key]);
  }
  return result;
}

/** Normalize all numbers to fixed precision (default 2 decimal places). */
export function normalizeNumbers(obj: any, precision = 2): any {
  if (obj == null || typeof obj !== 'object') {
    if (typeof obj === 'number') return Math.round(obj * 10 ** precision) / 10 ** precision;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(x => normalizeNumbers(x, precision));
  const result: any = {};
  for (const key of Object.keys(obj)) {
    result[key] = normalizeNumbers(obj[key], precision);
  }
  return result;
}

/** Normalize string values: trim, collapse whitespace, lowercase. */
export function normalizeStrings(obj: any): any {
  if (obj == null || typeof obj !== 'object') {
    if (typeof obj === 'string') return obj.trim().replace(/\s+/g, ' ');
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(normalizeStrings);
  const result: any = {};
  for (const key of Object.keys(obj)) {
    result[key] = normalizeStrings(obj[key]);
  }
  return result;
}

/** Strip ISO date strings to just the date portion (YYYY-MM-DD). */
export function normalizeDates(obj: any): any {
  if (obj == null || typeof obj !== 'object') {
    if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(obj)) {
      return obj.slice(0, 10);
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(normalizeDates);
  const result: any = {};
  for (const key of Object.keys(obj)) {
    result[key] = normalizeDates(obj[key]);
  }
  return result;
}

// ── Snapshot helpers ──────────────────────────────────────────────────

/**
 * Format a GoldenTestResult as an assertion error message.
 * Use with expect().toBe(true) or throw directly.
 */
export function formatGoldenFailure(result: GoldenTestResult, label?: string): string {
  const header = label ? `Golden test failed: ${label}` : 'Golden test failed';
  return `${header}\n${result.summary}`;
}
