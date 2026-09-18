/**
 * #275: TypeSafe AI / Jev — pure request/response shaping for `mode :decision`.
 *
 * Jev's HTTP API (`POST /v1/systemone`) is bespoke — not OpenAI- or
 * Anthropic-compatible (RESEARCH-275). This module builds the request body
 * and normalizes the response; the fetch + error handling lives in
 * `builtins.ts#typesafeProvider`, mirroring the `ollama.ts` split so both
 * halves are unit-testable without a live server.
 *
 * Wire mapping (DEC-013):
 *   choice question  → { type: 'choice', instructions, criteria: options }
 *   boolean question  → { type: 'noul',   instructions }
 *   choice answer     → { kind: 'choice',  choice, confidence, probabilities }
 *   noul answer        → { kind: 'boolean', probability: noul }
 *   usage              → { prompt_tokens: input_tokens, completion_tokens: output_tokens, total_tokens }
 */

import type { DecideOpts, DecideResult, DecisionQuestion, TokenUsage } from './types.js';

export const TYPESAFE_DEFAULT_BASEURL = 'https://api.typesafe.ai';

/** Build the request body for Jev's `POST /v1/systemone` endpoint. */
export function buildTypesafeRequest(opts: DecideOpts): Record<string, any> {
  const questions: Record<string, any> = {};
  for (const [name, q] of Object.entries(opts.questions)) {
    questions[name] =
      q.kind === 'choice'
        ? { type: 'choice', instructions: q.instructions, criteria: q.options }
        : { type: 'noul', instructions: q.instructions };
  }
  return {
    model: opts.model,
    state: opts.state,
    questions,
  };
}

/**
 * Normalize a Jev `/v1/systemone` response into `DecideResult`. Defense in
 * depth ahead of AJV (DEC-013): throws a plain `Error` naming the field when
 * an answer is missing, carries the wrong `type`, or (for a choice) names an
 * option outside the declared set — the vendor documents this as "never
 * happens", but a provider or normalization bug should fail loudly here
 * rather than let an out-of-set value reach validation.
 */
export function normalizeTypesafeResponse(
  json: any,
  questions: Record<string, DecisionQuestion>,
): DecideResult {
  const rawAnswers = json?.answers;
  if (!rawAnswers || typeof rawAnswers !== 'object') {
    throw new Error('TypeSafe: response is missing "answers".');
  }

  const answers: DecideResult['answers'] = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = rawAnswers[name];
    if (!a || typeof a !== 'object') {
      throw new Error(`TypeSafe: response is missing an answer for question '${name}'.`);
    }
    if (q.kind === 'choice') {
      if (a.type !== 'choice') {
        throw new Error(
          `TypeSafe: question '${name}' expected a "choice" answer, got type '${a?.type}'.`,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(q.options, a.choice)) {
        throw new Error(
          `TypeSafe: question '${name}' answered '${a.choice}', which is not one of the ` +
          `declared options (${Object.keys(q.options).join(', ')}).`,
        );
      }
      answers[name] = {
        kind: 'choice',
        choice: a.choice,
        confidence: a.confidence,
        probabilities: a.probabilities,
      };
    } else {
      if (a.type !== 'noul') {
        throw new Error(
          `TypeSafe: question '${name}' expected a "noul" (boolean) answer, got type '${a?.type}'.`,
        );
      }
      answers[name] = { kind: 'boolean', probability: a.noul };
    }
  }

  const usage: TokenUsage | undefined = json?.usage
    ? {
        prompt_tokens: json.usage.input_tokens ?? 0,
        completion_tokens: json.usage.output_tokens ?? 0,
        total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
      }
    : undefined;

  return { answers, usage };
}
