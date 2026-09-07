/**
 * #228 STEP-002 (DEC-001): `buildGenSystem` is one parameterized assembler,
 * not two.
 *
 * Both branches are pinned against FROZEN literal fixtures — not against
 * each other, and not against a re-derivation of the same code. The point
 * of a frozen fixture is that a whitespace edit inside the assembler fails
 * here loudly:
 *
 *   - Non-agentic (C-1): these are the exact bytes `handleGenerate` has
 *     always sent. Anthropic's cache key is a hash of the prompt prefix, so
 *     one stray space silently invalidates every warm entry a deployed
 *     consumer holds. A diff here is a build failure, not a nit.
 *   - Agentic: these are the exact bytes `handleAgenticGenerate` hand-rolled
 *     before DEC-001 folded it into the shared assembler. Byte-identity is
 *     what makes the refactor a refactor.
 */

import { describe, it, expect } from 'vitest';
import { buildGenSystem, handleAgenticGenerate } from './step-handlers.js';
import { schemaPromptBlock } from './schema-describe.js';

const SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

// The schema block is `schemaPromptBlock`'s output — a separately-owned
// unit with its own tests (schema-describe.test.ts). Pulled in by import
// rather than re-derived from buildGenSystem, so the fixtures below freeze
// THIS assembler's line order and separators, which is what #228 touches.
const SCHEMA_BLOCK = schemaPromptBlock(SCHEMA);

describe('buildGenSystem — non-agentic output is frozen (C-1)', () => {
  it('ungrounded gen: byte-identical to the pre-#228 single-shot system block', () => {
    const ir = { system: 'You are an analyst.', policies: {} };
    expect(buildGenSystem(ir, SCHEMA)).toBe([
      'You are an analyst.',
      '',
      SCHEMA_BLOCK,
      '',
      'OUTPUT RULES:',
      '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
      '- Output must start with "{" and end with "}".',
      '- If unsure, leave fields empty but valid.',
    ].join('\n'));
  });

  it('grounded gen: the GROUNDING RULES tail is byte-identical too', () => {
    const ir = {
      system: 'You are a reviewer.',
      policies: { grounding: { source: 'document', require_citations: true } },
    };
    expect(buildGenSystem(ir, SCHEMA)).toBe([
      'You are a reviewer.',
      '',
      SCHEMA_BLOCK,
      '',
      'OUTPUT RULES:',
      '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
      '- Output must start with "{" and end with "}".',
      '- If unsure, leave fields empty but valid.',
      '',
      'GROUNDING RULES:',
      '- Every item in arrays with a citations field MUST include citations.',
      '- Each citation MUST include a quote field with EXACT verbatim text from the document.',
      '- Do not paraphrase or fabricate quotes. Copy text exactly as it appears.',
    ].join('\n'));
  });

  it('no `system` declared: falls back to "analyst", tone-aware, unchanged', () => {
    expect(buildGenSystem({ policies: {} }, SCHEMA).split('\n')[0])
      .toBe('You are an analyst.');
    expect(
      buildGenSystem({ policies: { constraints: { tone: { to: 'skeptical' } } } }, SCHEMA)
        .split('\n')[0],
    ).toBe('You are a skeptical analyst.');
  });

  it('an explicit `agentic: false` is the same bytes as omitting opts entirely', () => {
    const ir = { system: 'You are an analyst.', policies: {} };
    expect(buildGenSystem(ir, SCHEMA, { agentic: false })).toBe(buildGenSystem(ir, SCHEMA));
    expect(buildGenSystem(ir, SCHEMA, {})).toBe(buildGenSystem(ir, SCHEMA));
  });
});

describe('buildGenSystem — agentic output matches the pre-#228 hand-rolled text', () => {
  it('ungrounded agentic gen: byte-identical to step-handlers.ts:912-937 as it stood', () => {
    const ir = { system: 'You are a research agent.', policies: {} };
    expect(buildGenSystem(ir, SCHEMA, { agentic: true })).toBe([
      'You are a research agent.',
      '',
      SCHEMA_BLOCK,
      '',
      'You have access to tools. Call them as needed to complete the task.',
      'When you are done, respond with the final JSON output matching the schema above.',
      'OUTPUT RULES:',
      '- Final output MUST be JSON only. No markdown. No code fences. No reasoning.',
      '- Final output must start with "{" and end with "}".',
    ].join('\n'));
  });

  it('grounded agentic gen: the agentic GROUNDING RULES wording is preserved verbatim', () => {
    const ir = {
      system: 'You are a research agent.',
      policies: { grounding: { source: 'document', require_citations: true } },
    };
    expect(buildGenSystem(ir, SCHEMA, { agentic: true })).toBe([
      'You are a research agent.',
      '',
      SCHEMA_BLOCK,
      '',
      'You have access to tools. Call them as needed to complete the task.',
      'When you are done, respond with the final JSON output matching the schema above.',
      'OUTPUT RULES:',
      '- Final output MUST be JSON only. No markdown. No code fences. No reasoning.',
      '- Final output must start with "{" and end with "}".',
      '',
      'GROUNDING RULES:',
      '- Every item in arrays with a citations field MUST include citations.',
      '- Each citation MUST include a quote field with EXACT verbatim text from the document.',
      // NOT the single-shot wording — the agentic block never carried the
      // trailing "Copy text exactly as it appears." sentence.
      '- Do not paraphrase or fabricate quotes.',
    ].join('\n'));
  });

  it('no `system` declared: falls back to "agent", not "analyst"', () => {
    expect(buildGenSystem({ policies: {} }, SCHEMA, { agentic: true }).split('\n')[0])
      .toBe('You are an agent.');
    expect(
      buildGenSystem(
        { policies: { constraints: { tone: { to: 'skeptical' } } } },
        SCHEMA,
        { agentic: true },
      ).split('\n')[0],
    ).toBe('You are a skeptical agent.');
  });

  it('the two variants really do differ — a no-op `agentic` flag would pass everything above', () => {
    const ir = { system: 'You are a research agent.', policies: {} };
    expect(buildGenSystem(ir, SCHEMA, { agentic: true })).not.toBe(buildGenSystem(ir, SCHEMA));
  });
});

describe('handleAgenticGenerate dispatches the agentic system block', () => {
  it('the system message on the wire is exactly buildGenSystem(ir, schema, { agentic: true })', async () => {
    const ir = {
      mode: 'agentic',
      model: { id: 'omlx:mock', max_tokens: 512, temperature: 0.2 },
      system: 'You are a research agent.',
      context: { document: 'a short doc' },
      policies: {},
    };
    let seen: any;
    const generateWithTools = async (opts: any) => {
      seen = opts;
      return { message: { content: '{"summary":"ok","tags":[]}', tool_calls: undefined } };
    };
    await handleAgenticGenerate(
      { id: 'g', prompt: 'Investigate.' },
      ir,
      SCHEMA,
      [],
      {} as any,
      [],
      generateWithTools,
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 3,
      {},
    );
    expect(seen.messages[0].role).toBe('system');
    expect(seen.messages[0].content).toBe(buildGenSystem(ir, SCHEMA, { agentic: true }));
  });
});
