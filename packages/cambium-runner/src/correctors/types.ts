export type CorrectorIssue = {
  path: string;
  message: string;
  severity: 'fixed' | 'warning' | 'error';
  original?: any;
  corrected?: any;
};

export type CorrectorResult = {
  corrected: boolean;
  output: any;
  issues: CorrectorIssue[];
  meta?: Record<string, any>;
};

/**
 * What a corrector is handed alongside the data.
 *
 * `document` is the grounding source as the MODEL saw it. `derivedDocument`
 * (#169) is the optional format-aware plain-text view of that same source —
 * visible Markdown text, decoded JSON strings. It is verifier-only by
 * design (DEC-001): it never enters `groundingTextByKey`, so no prompt and
 * no prompt-cache key moves because a gen declared a `format:`.
 */
export type CorrectorContext = {
  document?: string;
  derivedDocument?: string;
  fields?: string[];
};

export type CorrectorFn = (data: any, context: CorrectorContext) => CorrectorResult;

/** Which haystack a passing citation / field value was found in (#169). */
export type MatchedVia = 'document' | 'derived';
