/**
 * RED-419 C2/STEP-003: the runner resolves the validation schema from
 * `ir.returnSchema` (inline, block form) when present, falling back to
 * the injected contracts module via `ir.returnSchemaId` (symbol form).
 *
 * A block-form gen runs end-to-end with NO injected schemas — proving
 * the "one file, run it" decoupling (DEC-001/DEC-002).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGen } from './runner.js';

// The mock model (runner.ts:mockGenerate) emits a fixed payload for the
// default branch: { summary: string, metrics: object, key_facts: array }.
const MOCK_PAYLOAD_KEYS = ['summary', 'metrics', 'key_facts'];

function inlineSchema(required: string[]) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      metrics: { type: 'object' },
      key_facts: { type: 'array' },
    },
    required,
    additionalProperties: false,
    $id: 'InlineOutput',
  };
}

function blockFormIR(returnSchema: any) {
  return {
    version: '0.2',
    entry: { class: 'Inline', method: 'analyze', source: 'inline.cmb.rb' },
    model: { id: 'omlx:test-model', temperature: 0.1, max_tokens: 100 },
    system: 'test system',
    mode: 'single' as const,
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding: null,
      security: {},
    },
    // Block form: schema travels inline; NO returnSchemaId.
    returnSchema,
    context: { document: 'test document' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [
      {
        id: 'generate_1',
        type: 'Generate' as const,
        prompt: 'say something',
        with: { context: 'test document' },
        returns: null,
      },
    ],
  };
}

describe('RED-419 runner consumes inline returnSchema (STEP-003)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('validates a block-form gen against its inline schema with NO injected schemas', async () => {
    const result = await runGen({
      ir: blockFormIR(inlineSchema(['summary'])),
      // Deliberately empty — the inline schema must be self-sufficient.
      schemas: {},
    });
    expect(result.ok).toBe(true);
    expect(result.trace.final.schema_id).toBe('InlineOutput');
    // The validated output is the mock payload.
    expect(Object.keys(result.output).sort()).toEqual([...MOCK_PAYLOAD_KEYS].sort());
  });

  it('fails validation when the mock output violates the inline schema', async () => {
    // Require a field the mock never emits → validation fails after repair.
    const result = await runGen({
      ir: blockFormIR(inlineSchema(['summary', 'missing_required_field'])),
      schemas: {},
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('validation');
  });

  it('inline returnSchema wins over an injected returnSchemaId match', async () => {
    // IR carries BOTH (shouldn't happen from compile.rb, but the `??`
    // precedence is the contract): inline must take priority.
    const ir: any = blockFormIR(inlineSchema(['summary']));
    ir.returnSchemaId = 'SomethingElse';
    const result = await runGen({
      ir,
      schemas: {
        // A bogus injected schema that would reject the mock payload if used.
        SomethingElse: { $id: 'SomethingElse', type: 'string' },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.trace.final.schema_id).toBe('InlineOutput');
  });
});
