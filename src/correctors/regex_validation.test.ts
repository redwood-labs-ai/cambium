import { describe, it, expect } from 'vitest';
import { regexValidation } from '../../src/correctors/regex_validation.js';

describe('regex_validation corrector', () => {
  it('passes valid pattern with matching test cases', () => {
    const data = {
      pattern: { regex: '\\beval\\s*\\(', description: 'Calls to eval()' },
      test_cases: {
        matches: ['eval(userInput);', '  eval (code);'],
        non_matches: ['evaluate(x);', '// eval commented'],
      },
    };

    const result = regexValidation(data, {});
    expect(result.corrected).toBe(false);
    expect(result.issues.filter((i: any) => i.severity === 'error')).toHaveLength(0);
  });

  it('catches broken regex', () => {
    const data = {
      pattern: { regex: '[unclosed', description: 'bad regex' },
      test_cases: { matches: ['test'], non_matches: [] },
    };

    const result = regexValidation(data, {});
    expect(result.issues.some((i: any) => i.severity === 'error')).toBe(true);
  });

  it('catches test case mismatches', () => {
    const data = {
      pattern: { regex: '^hello$', description: 'exact hello' },
      test_cases: {
        matches: ['hello', 'world'],  // 'world' shouldn't match
        non_matches: ['hello world'],
      },
    };

    const result = regexValidation(data, {});
    const errors = result.issues.filter((i: any) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('warns on missing test cases', () => {
    const data = {
      pattern: { regex: 'test.*pattern', description: 'a pattern' },
      test_cases: { matches: [], non_matches: [] },
    };

    const result = regexValidation(data, {});
    const warnings = result.issues.filter((i: any) => i.severity === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('passes when non_matches correctly do not match', () => {
    const data = {
      pattern: { regex: 'SELECT.*FROM', description: 'SQL SELECT' },
      test_cases: {
        matches: ['SELECT * FROM users'],
        non_matches: ['INSERT INTO users', 'select from'],
      },
    };

    const result = regexValidation(data, {});
    const errors = result.issues.filter((i: any) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});
