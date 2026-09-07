import type { CorrectorFn, CorrectorResult, CorrectorIssue, MatchedVia } from './types.js';

/**
 * Citations corrector: verifies that cited quotes exist in the source document
 * and that claim items have citations when required.
 *
 * This corrector flags issues but does not auto-fix — fabricated quotes
 * can't be deterministically corrected. Issues feed into the repair loop.
 */
/** Result from citation verification — structured for trace + repair. */
export type CitationResult = {
  // #169: `matched_via` says which haystack the quote was found in —
  // 'derived' means it passes ONLY because of the format-aware view, which
  // is the signal a trace reader wants when tuning a deriver. Optional so
  // hand-built results stay assignable.
  passed: Array<{ path: string; quote: string; matched_via?: MatchedVia }>;
  failed: Array<{ path: string; quote: string; reason: string }>;
  missing: Array<{ path: string }>;
  totalChecked: number;
  allValid: boolean;
};

export const citations: CorrectorFn = (data, context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);
  const document = context.document ?? '';
  const derivedDocument = context.derivedDocument;

  const citationResult: CitationResult = {
    passed: [],
    failed: [],
    missing: [],
    totalChecked: 0,
    allValid: true,
  };

  walkAndCheck(output, '', document, derivedDocument, issues, citationResult);

  return {
    corrected: false,
    output,
    issues,
    meta: { citationResult },
  };
};

function walkAndCheck(obj: any, basePath: string, document: string, derivedDocument: string | undefined, issues: CorrectorIssue[], citationResult: CitationResult): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCheck(obj[i], `${basePath}[${i}]`, document, derivedDocument, issues, citationResult);
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
          const matchedVia = findQuoteMatch(cit.quote, document, derivedDocument);
          if (matchedVia) {
            citationResult.passed.push({
              path: `${basePath}.citations[${i}].quote`,
              quote: cit.quote,
              matched_via: matchedVia,
            });
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
    walkAndCheck(obj[key], `${basePath}.${key}`, document, derivedDocument, issues, citationResult);
  }
}

/**
 * #169: any-of over the two haystacks. Raw first, derived second — so
 * `matched_via: 'derived'` means exactly "this quote passes ONLY because
 * of the format-aware view", and a model that copied the literal markup
 * keeps passing the way it always did.
 */
function findQuoteMatch(
  quote: string,
  document: string,
  derivedDocument: string | undefined,
): MatchedVia | null {
  if (quoteExistsInDocument(quote, document)) return 'document';
  if (derivedDocument !== undefined && quoteExistsInDocument(quote, derivedDocument)) return 'derived';
  return null;
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
