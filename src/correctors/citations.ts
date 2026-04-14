import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

/**
 * Citations corrector: verifies that cited quotes exist in the source document
 * and that claim items have citations when required.
 *
 * This corrector flags issues but does not auto-fix — fabricated quotes
 * can't be deterministically corrected. Issues feed into the repair loop.
 */
/** Result from citation verification — structured for trace + repair. */
export type CitationResult = {
  passed: Array<{ path: string; quote: string }>;
  failed: Array<{ path: string; quote: string; reason: string }>;
  missing: Array<{ path: string }>;
  totalChecked: number;
  allValid: boolean;
};

export const citations: CorrectorFn = (data, context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);
  const document = context.document ?? '';

  const citationResult: CitationResult = {
    passed: [],
    failed: [],
    missing: [],
    totalChecked: 0,
    allValid: true,
  };

  walkAndCheck(output, '', document, issues, citationResult);

  return {
    corrected: false,
    output,
    issues,
    meta: { citationResult },
  };
};

function walkAndCheck(obj: any, basePath: string, document: string, issues: CorrectorIssue[], citationResult: CitationResult): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCheck(obj[i], `${basePath}[${i}]`, document, issues, citationResult);
    }
    return;
  }

  // Check if this object has a citations field
  if ('citations' in obj) {
    const cits = obj.citations;

    if (!Array.isArray(cits) || cits.length === 0) {
      citationResult.missing.push({ path: `${basePath}.citations` });
      citationResult.allValid = false;
      issues.push({
        path: `${basePath}.citations`,
        message: 'Missing citations for this item',
        severity: 'error',
      });
    } else {
      // Verify each citation's quote against the document
      for (let i = 0; i < cits.length; i++) {
        const cit = cits[i];
        if (cit.quote && typeof cit.quote === 'string') {
          citationResult.totalChecked++;
          if (quoteExistsInDocument(cit.quote, document)) {
            citationResult.passed.push({ path: `${basePath}.citations[${i}].quote`, quote: cit.quote });
          } else {
            citationResult.failed.push({
              path: `${basePath}.citations[${i}].quote`,
              quote: cit.quote,
              reason: 'not found in source document',
            });
            citationResult.allValid = false;
            issues.push({
              path: `${basePath}.citations[${i}].quote`,
              message: `Cited quote not found in source document: "${cit.quote.slice(0, 80)}${cit.quote.length > 80 ? '...' : ''}"`,
              severity: 'error',
              original: cit.quote,
            });
          }
        }
      }
    }
  }

  // Recurse into nested objects/arrays
  for (const key of Object.keys(obj)) {
    if (key === 'citations') continue; // already checked
    walkAndCheck(obj[key], `${basePath}.${key}`, document, issues, citationResult);
  }
}

/**
 * Fuzzy check: does this quote appear in the document?
 * Normalizes whitespace and does case-insensitive comparison.
 */
function quoteExistsInDocument(quote: string, document: string): boolean {
  const normalizedQuote = normalize(quote);
  const normalizedDoc = normalize(document);

  // Exact substring match (after normalization)
  if (normalizedDoc.includes(normalizedQuote)) return true;

  // Try without punctuation differences
  const stripped = (s: string) => s.replace(/[.,;:!?'"()\-]/g, '').replace(/\s+/g, ' ');
  if (stripped(normalizedDoc).includes(stripped(normalizedQuote))) return true;

  return false;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
