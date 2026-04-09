import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

/**
 * Citations corrector: verifies that cited quotes exist in the source document
 * and that claim items have citations when required.
 *
 * This corrector flags issues but does not auto-fix — fabricated quotes
 * can't be deterministically corrected. Issues feed into the repair loop.
 */
export const citations: CorrectorFn = (data, context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);
  const document = context.document ?? '';

  walkAndCheck(output, '', document, issues);

  return {
    corrected: false, // citations corrector only flags, never auto-fixes
    output,
    issues,
  };
};

function walkAndCheck(obj: any, basePath: string, document: string, issues: CorrectorIssue[]): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCheck(obj[i], `${basePath}[${i}]`, document, issues);
    }
    return;
  }

  // Check if this object has a citations field
  if ('citations' in obj) {
    const cits = obj.citations;

    if (!Array.isArray(cits) || cits.length === 0) {
      // Missing citations — flag if require_citations is active
      // (caller decides whether this is an error based on grounding policy)
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
          if (!quoteExistsInDocument(cit.quote, document)) {
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
    walkAndCheck(obj[key], `${basePath}.${key}`, document, issues);
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
