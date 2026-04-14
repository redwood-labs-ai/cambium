/**
 * Regex validation corrector for scanner patterns.
 * Deterministically validates:
 *   1. The regex compiles (catches syntax errors)
 *   2. All test_cases.matches actually match
 *   3. All test_cases.non_matches do NOT match
 *
 * Fixes obvious issues (stray slashes, flag problems).
 * Reports what can't be auto-fixed.
 */

import type { CorrectorFn, CorrectorResult } from './types.js';

export const regexValidation: CorrectorFn = (data: any, _context: { document?: string }): CorrectorResult => {
  const issues: CorrectorResult['issues'] = [];
  let corrected = false;
  const output = structuredClone(data);

  // 1. Validate regex compiles
  const regex = output?.pattern?.regex;
  if (!regex) {
    return {
      corrected: false,
      output: data,
      issues: [{ path: '/pattern/regex', message: 'pattern.regex is missing', severity: 'error' }],
    };
  }

  let re: RegExp;
  try {
    re = new RegExp(regex, output.pattern?.flags ?? '');
  } catch (err: any) {
    // Try common fix: remove leading/trailing slashes if present
    const cleaned = regex.replace(/^\/|\/[gimsuy]*$/g, '');
    try {
      const flags = output.pattern?.flags ?? '';
      re = new RegExp(cleaned, flags);
      output.pattern.regex = cleaned;
      corrected = true;
      issues.push({
        path: '/pattern/regex',
        message: 'Removed stray slashes from regex',
        severity: 'fixed',
        original: regex,
        corrected: cleaned,
      });
    } catch {
      return {
        corrected: false,
        output: data,
        issues: [{ path: '/pattern/regex', message: `Regex compilation failed: ${err.message}`, severity: 'error' }],
      };
    }
  }

  // 2. Check test_cases.matches
  const matches: string[] = output?.test_cases?.matches ?? [];
  for (let i = 0; i < matches.length; i++) {
    if (!re.test(matches[i])) {
      issues.push({
        path: `/test_cases/matches/${i}`,
        message: `Expected match but didn't: "${matches[i].slice(0, 80)}"`,
        severity: 'error',
      });
    }
  }

  // 3. Check test_cases.non_matches
  const nonMatches: string[] = output?.test_cases?.non_matches ?? [];
  for (let i = 0; i < nonMatches.length; i++) {
    if (re.test(nonMatches[i])) {
      issues.push({
        path: `/test_cases/non_matches/${i}`,
        message: `Expected non-match but matched: "${nonMatches[i].slice(0, 80)}"`,
        severity: 'error',
      });
    }
  }

  // 4. Pattern quality checks
  if (regex.length < 5) {
    issues.push({
      path: '/pattern/regex',
      message: 'Regex is suspiciously short — likely too broad',
      severity: 'warning',
    });
  }
  if (matches.length === 0) {
    issues.push({
      path: '/test_cases/matches',
      message: 'No positive test cases — pattern untested',
      severity: 'warning',
    });
  }
  if (nonMatches.length === 0) {
    issues.push({
      path: '/test_cases/non_matches',
      message: 'No negative test cases — false positive risk',
      severity: 'warning',
    });
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { corrected, output, issues, ok: !hasErrors } as CorrectorResult & { ok: boolean };
};
