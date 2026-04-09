import type { GenerateTextFn, ExtractJsonFn, TokenUsage } from './step-handlers.js';

// ── Review ────────────────────────────────────────────────────────────

export type ReviewIssue = {
  path: string;
  message: string;
};

export type ReviewResult = {
  ok: boolean;
  issues: ReviewIssue[];
  ms: number;
  raw_preview: string;
  usage?: TokenUsage;
};

/**
 * Review: a second LLM call audits the output against the source document.
 * Returns a list of issues (missing data, incorrect values, omissions).
 */
export async function runReview(
  parsed: any,
  ir: any,
  schema: any,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
): Promise<ReviewResult> {
  const doc = ir.context?.document;

  const system = [
    'You are a data quality reviewer.',
    'CRITICAL OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
    '- Output must start with "{" and end with "}".',
  ].join('\n');

  const prompt = [
    'TASK: Compare the OUTPUT against the SOURCE DOCUMENT.',
    'Check for:',
    '- Data points in the document that are missing from the output',
    '- Numeric values that are incorrect or rounded when they should be exact',
    '- Arrays that should contain more entries based on the document',
    '',
    'SOURCE DOCUMENT:',
    String(doc ?? ''),
    '',
    'OUTPUT BEING REVIEWED:',
    JSON.stringify(parsed, null, 2),
    '',
    'Return JSON: { "issues": [{ "path": "<json path>", "message": "<what is wrong>" }] }',
    'If the output is faithful to the document, return: { "issues": [] }',
  ].join('\n');

  const started = Date.now();
  const genResult = await generateText({
    model: ir.model.id,
    system,
    prompt,
    max_tokens: 300,
    temperature: 0.1,
  });

  const raw = genResult.text;
  let issues: ReviewIssue[] = [];
  try {
    const reviewOutput = extractJson(raw);
    if (Array.isArray(reviewOutput.issues)) {
      issues = reviewOutput.issues.filter(
        (i: any) => i && typeof i.path === 'string' && typeof i.message === 'string'
      );
    }
  } catch {
    // If we can't parse the review, treat as no issues (fail open — the review is advisory)
  }

  return {
    ok: issues.length === 0,
    issues,
    ms: Date.now() - started,
    raw_preview: raw.slice(0, 400),
    usage: genResult.usage,
  };
}

// ── Consensus ─────────────────────────────────────────────────────────

export type Disagreement = {
  path: string;
  values: any[];
  message: string;
};

export type ConsensusResult = {
  ok: boolean;
  agreed: any;
  disagreements: Disagreement[];
};

/**
 * Consensus: compare N outputs field-by-field.
 * Where all agree, keep. Where they disagree, report.
 */
export function runConsensus(outputs: any[]): ConsensusResult {
  if (outputs.length < 2) {
    return { ok: true, agreed: outputs[0], disagreements: [] };
  }

  const disagreements: Disagreement[] = [];
  const agreed = structuredClone(outputs[0]);

  compareFields(outputs, agreed, '', disagreements);

  return {
    ok: disagreements.length === 0,
    agreed,
    disagreements,
  };
}

function compareFields(
  outputs: any[],
  agreed: any,
  basePath: string,
  disagreements: Disagreement[],
): void {
  if (agreed == null || typeof agreed !== 'object') return;

  if (Array.isArray(agreed)) {
    // Check array lengths across outputs
    const lengths = outputs.map(o => {
      const val = resolvePath(o, basePath);
      return Array.isArray(val) ? val.length : 0;
    });
    const allSame = lengths.every(l => l === lengths[0]);

    if (!allSame) {
      disagreements.push({
        path: basePath,
        values: outputs.map(o => resolvePath(o, basePath)),
        message: `Array lengths differ across passes: [${lengths.join(', ')}]`,
      });
      // Take the longest array as the consensus (more data = better)
      const longestIdx = lengths.indexOf(Math.max(...lengths));
      const longestVal = resolvePath(outputs[longestIdx], basePath);
      setPath(agreed, basePath, structuredClone(longestVal));
    }
    return;
  }

  for (const key of Object.keys(agreed)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const values = outputs.map(o => resolvePath(o, path));

    if (values.every(v => typeof v === 'object' && v !== null && !Array.isArray(v))) {
      compareFields(outputs, agreed[key], path, disagreements);
    } else if (values.every(v => Array.isArray(v))) {
      compareFields(outputs, agreed[key], path, disagreements);
    } else {
      // Primitive comparison
      const allEqual = values.every(v => JSON.stringify(v) === JSON.stringify(values[0]));
      if (!allEqual) {
        disagreements.push({
          path,
          values,
          message: `Values differ across passes`,
        });
      }
    }
  }
}

function resolvePath(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setPath(obj: any, path: string, value: any): void {
  if (!path) return;
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
