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

function inlineSchema(required: string[], extraProperties: Record<string, any> = {}) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      metrics: { type: 'object' },
      key_facts: { type: 'array' },
      ...extraProperties,
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
    // NOTE (A-001, #205): this is an UNSATISFIABLE schema, not a mock
    // limitation — `missing_required_field` is required but never declared
    // in `properties`, and `additionalProperties: false` forbids adding a
    // key with no declared shape. No mock (schema-derived or otherwise)
    // could ever satisfy it; that's the point — it's the fail-closed proof
    // that a genuinely-unsatisfiable schema still fails Validate.
    const result = await runGen({
      ir: blockFormIR(inlineSchema(['summary', 'missing_required_field'])),
      schemas: {},
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('validation');
  });

  it('#205 (DEC-005/A-001b): derives a schema-valid mock when the default payload does not fit', async () => {
    // Same shape as the test above, but `extra` IS declared this time — the
    // walker can derive it, so the schema is satisfiable and the run
    // succeeds. This is the ticket's headline case: a `returns do … end`
    // schema with a field the default mock payload lacks.
    const result = await runGen({
      ir: blockFormIR(inlineSchema(['summary', 'extra'], { extra: { type: 'string' } })),
      schemas: {},
    });
    expect(result.ok).toBe(true);
    expect(result.output.extra).toBe('mock extra');
    expect(Object.keys(result.output)).toEqual(['summary', 'metrics', 'key_facts', 'extra']);
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

describe('runGen structured result on malformed budget config', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('returns ok:false with BudgetParseFailed trace step on malformed budget (not an uncaught throw)', async () => {
    const ir: any = blockFormIR(inlineSchema(['summary']));
    // Inject a malformed per_run.max_tokens — parseBudget throws; runGen must catch it.
    ir.policies.budget = { per_run: { max_tokens: 'lots' } };
    const result = await runGen({ ir, schemas: {} });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/Budget config invalid/);
    const failStep = result.trace.steps.find((s: any) => s.type === 'BudgetParseFailed');
    expect(failStep).toBeDefined();
    expect(failStep.ok).toBe(false);
    expect(failStep.errors[0].message).toContain('[cambium] invalid budget');
  });
});
