import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

/**
 * RED-392: Field-values corrector. Verifies that leaf values in the
 * output schema appear (or are derivable) from the grounding document.
 *
 * This is the value-level cross-check that complements the citation-level
 * check. Citations verify: "you cited a quote that exists". Field-values
 * verify: "the values you extracted are actually in the document".
 *
 * Example: an invoice parser returns { total_cents: 12345, vendor: "Acme" }.
 * The field-values corrector checks that "12345" and "Acme" appear in the
 * grounding document text. Fails into the repair loop when mismatches are found.
 *
 * Like the citations corrector, this is a verification-only corrector —
 * it flags issues but does not auto-fix. The repair loop handles re-generation.
 */
export type FieldValuesResult = {
  passed: Array<{ path: string; value: any }>;
  failed: Array<{ path: string; value: any; reason: string }>;
  skipped: Array<{ path: string; reason: string }>;
  totalChecked: number;
  allValid: boolean;
};

export const fieldValues: CorrectorFn = (data, context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);
  const document = context.document ?? '';

  const fieldResult: FieldValuesResult = {
    passed: [],
    failed: [],
    skipped: [],
    totalChecked: 0,
    allValid: true,
  };

  walkAndCheck(output, '', document, issues, fieldResult, context.fields);

  return {
    corrected: false,
    output,
    issues,
    meta: { fieldValuesResult: fieldResult },
  };
};

function walkAndCheck(
  obj: any,
  basePath: string,
  document: string,
  issues: CorrectorIssue[],
  fieldResult: FieldValuesResult,
  fields?: string[],
): void {
  if (obj == null) return;

  // Skip non-objects (primitives at the root)
  if (typeof obj !== 'object') {
    checkLeafValue('', obj, document, issues, fieldResult);
    return;
  }

  // Arrays: check each element
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCheck(obj[i], `${basePath}[${i}]`, document, issues, fieldResult);
    }
    return;
  }

  // Objects: skip citations fields (already verified by citations corrector),
  // then recurse into all other fields
  for (const key of Object.keys(obj)) {
    // DEC-006: top-level fields allowlist — skip keys not named when fields is set.
    if (fields && fields.length > 0 && basePath === '' && !fields.includes(key)) {
      fieldResult.skipped.push({
        path: key,
        reason: 'not in fields allowlist',
      });
      continue;
    }

    if (key === 'citations') {
      fieldResult.skipped.push({
        path: basePath ? `${basePath}.${key}` : key,
        reason: 'already verified by citations corrector',
      });
      continue;
    }

    const value = obj[key];
    const path = basePath ? `${basePath}.${key}` : key;

    // Recurse into nested objects/arrays
    if (value != null && typeof value === 'object') {
      walkAndCheck(value, path, document, issues, fieldResult);
    } else {
      // Leaf value — verify it
      checkLeafValue(path, value, document, issues, fieldResult);
    }
  }
}

function checkLeafValue(
  path: string,
  value: any,
  document: string,
  issues: CorrectorIssue[],
  fieldResult: FieldValuesResult,
): void {
  // Skip null/undefined
  if (value == null) {
    fieldResult.skipped.push({ path, reason: 'null/undefined' });
    return;
  }

  // Skip booleans (not meaningful for grounding)
  if (typeof value === 'boolean') {
    fieldResult.skipped.push({ path, reason: 'boolean' });
    return;
  }

  // Convert to string for grounding check
  const valueStr = String(value);

  // DEC-004: skip values too short for reliable substring match. Length is
  // measured on the trimmed string so the guard agrees with the matcher,
  // which normalizes/trims before comparing (AUD-004) — otherwise a padded
  // "  x" would clear the guard yet match on a 1-char substring.
  if (valueStr.trim().length < 3) {
    fieldResult.skipped.push({ path, reason: 'too short for reliable match' });
    return;
  }

  fieldResult.totalChecked++;

  if (valueExistsInDocument(valueStr, document)) {
    fieldResult.passed.push({ path, value });
  } else {
    fieldResult.failed.push({
      path,
      value,
      reason: 'value not found in grounding document',
    });
    fieldResult.allValid = false;

    const truncated = valueStr.length > 60 ? `${valueStr.slice(0, 57)}...` : valueStr;
    issues.push({
      path,
      message: `Field value not found in grounding document: "${truncated}"`,
      severity: 'error',
      original: value,
    });
  }
}

/**
 * Fuzzy check: does this value appear in the document?
 * Normalizes whitespace, does case-insensitive comparison, and handles
 * numeric formatting variations (e.g., "1,234" vs "1234").
 */
function valueExistsInDocument(value: string, document: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedDoc = normalize(document);

  // Exact substring match (after normalization)
  if (normalizedDoc.includes(normalizedValue)) return true;

  // Try without punctuation (commas, periods, dollar signs)
  const stripped = (s: string) => s.replace(/[,$€£¥.]/g, '');
  if (stripped(normalizedDoc).includes(stripped(normalizedValue))) return true;

  return false;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}
