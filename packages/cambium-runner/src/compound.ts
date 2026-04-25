import type { GenerateTextFn, ExtractJsonFn, TokenUsage } from './step-handlers.js';
import { getGroundingDocument } from './context.js';

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
  /** RED-325: skipped_reason set when the review couldn't run (provider
   *  failure, etc). Distinguishes "review ran and found nothing" from
   *  "review couldn't run" — both produce empty issues[] but only the
   *  latter has skipped_reason. Trace consumers should branch on this. */
  meta?: { skipped_reason?: string; error?: string };
};

// RED-325 Part 1: default max_tokens raised from 300 (truncated every
// non-trivial review) to 2000. Reviewers compare schema-shaped output
// against source documents; 300 tokens couldn't fit even a small
// `{"issues": [...]}` envelope with 5–10 items.
const DEFAULT_REVIEW_MAX_TOKENS = 2000;
const DEFAULT_REVIEW_TEMPERATURE = 0.1;

/**
 * Review: a second LLM call audits the output against the source document.
 * Returns a list of issues (missing data, incorrect values, omissions).
 *
 * RED-325 Part 1: per-gen knobs from `constrain :compound, strategy: :review,
 * max_tokens:, temperature:, model:` flow in via compoundConfig. The
 * `model` knob lets a gen run its main call on Sonnet and the review on
 * Haiku — large cost reduction without quality loss for "internally
 * consistent" checks.
 *
 * RED-325 Part 2: provider failures DO NOT throw. Documented as advisory
 * but pre-RED-325 a single 30-second flaky API call would crash the host
 * gen. Catch + return ok-false-with-skipped-reason; downstream code that
 * branches on review.ok keeps working; the trace records why.
 */
export async function runReview(
  parsed: any,
  ir: any,
  schema: any,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
  /** RED-323: pass PDF-extracted text through so Review sees real
   *  content when grounding source is a document envelope. */
  groundingTextByKey?: Record<string, string>,
  /** RED-325: per-gen knobs lifted from `constraints.compound`.
   *  Caller (runner.ts) reads these from the IR and passes through. */
  compoundConfig?: { max_tokens?: number; temperature?: number; model?: string },
): Promise<ReviewResult> {
  const doc = getGroundingDocument(ir, groundingTextByKey);

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
  let genResult: { text: string; usage?: TokenUsage };
  try {
    genResult = await generateText({
      model: compoundConfig?.model ?? ir.model.id,
      system,
      prompt,
      max_tokens: compoundConfig?.max_tokens ?? DEFAULT_REVIEW_MAX_TOKENS,
      temperature: compoundConfig?.temperature ?? DEFAULT_REVIEW_TEMPERATURE,
    });
  } catch (e: any) {
    // RED-325 Part 2: review is advisory — provider failure must not
    // crash the host gen. ok-false flags that the review didn't actually
    // run; meta.skipped_reason makes the failure greppable in trace.
    return {
      ok: false,
      issues: [],
      ms: Date.now() - started,
      raw_preview: '',
      usage: undefined,
      meta: {
        skipped_reason: 'provider_error',
        error: e?.message ?? String(e),
      },
    };
  }

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
    // If we can't parse the review, treat as no issues (fail open — the review is advisory).
    // No skipped_reason here: the call succeeded, the model just produced unparseable output.
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
  agreedRoot: any,
  basePath: string,
  disagreements: Disagreement[],
): void {
  const current = basePath ? resolvePath(agreedRoot, basePath) : agreedRoot;
  if (current == null || typeof current !== 'object') return;

  if (Array.isArray(current)) {
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
      setPath(agreedRoot, basePath, structuredClone(longestVal));
    }
    return;
  }

  for (const key of Object.keys(current)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const values = outputs.map(o => resolvePath(o, path));

    if (values.every(v => typeof v === 'object' && v !== null && !Array.isArray(v))) {
      compareFields(outputs, agreedRoot, path, disagreements);
    } else if (values.every(v => Array.isArray(v))) {
      compareFields(outputs, agreedRoot, path, disagreements);
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
