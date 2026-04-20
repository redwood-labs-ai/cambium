import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGen } from './runner.js';
import {
  correctors,
  registerAppCorrectors,
  _resetAppCorrectorsForTests,
} from './correctors/index.js';
import type { CorrectorFn } from './correctors/types.js';

const BUILTINS = ['math', 'dates', 'currency', 'citations'];

/**
 * RED-275: an app-level corrector that returns `{ corrected: false,
 * issues: [{ severity: 'error', ... }] }` should feed those issues back
 * into a repair attempt (mirroring the grounding path). Verified by
 * inspecting the trace for the Repair + ValidateAfterCorrectorRepair
 * steps.
 *
 * Before RED-275, errored issues from non-citation correctors silently
 * disappeared into the trace — no repair attempt was made, so the LLM
 * never learned to fix its output. That invariant is now lifted.
 */

// Mock's output shape (see runner.ts:mockGenerate).
const MockSchema: any = {
  $id: 'MockOutput',
  type: 'object',
  additionalProperties: true,
  properties: {
    summary: { type: 'string' },
    metrics: { type: 'object' },
    key_facts: { type: 'array' },
  },
  required: ['summary'],
};

function baseIR(correctorNames: string[]) {
  return {
    version: '0.2',
    entry: { class: 'Test', method: 'test', source: 'test.cmb.rb' },
    model: { id: 'omlx:test-model', temperature: 0.1, max_tokens: 100 },
    system: 'test system',
    mode: 'single' as const,
    policies: {
      tools_allowed: [],
      correctors: correctorNames,
      constraints: {},
      grounding: null,
      security: {},
    },
    returnSchemaId: 'MockOutput',
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
        returns: 'MockOutput',
      },
    ],
  };
}

describe('corrector error-severity issues feed the repair loop (RED-275)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    _resetAppCorrectorsForTests(BUILTINS);
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('triggers Repair + ValidateAfterCorrectorRepair when a corrector returns error issues', async () => {
    const reportsError: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        {
          path: '.summary',
          message: 'summary fails the domain check',
          severity: 'error',
        },
      ],
    });
    registerAppCorrectors({ reports_error: reportsError });

    const result = await runGen({
      ir: baseIR(['reports_error']),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);

    // The pre-RED-275 trace would have stopped at [Generate, Validate, Correct].
    // Post-RED-275 must include the Repair + ValidateAfterCorrectorRepair steps.
    expect(stepTypes).toContain('Correct');
    expect(stepTypes).toContain('Repair');
    expect(stepTypes).toContain('ValidateAfterCorrectorRepair');
  });

  it('does NOT trigger repair when corrector issues are all non-error severity', async () => {
    const warnOnly: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        {
          path: '.summary',
          message: 'would like this tighter',
          severity: 'warning',
        },
      ],
    });
    registerAppCorrectors({ warn_only: warnOnly });

    const result = await runGen({
      ir: baseIR(['warn_only']),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);

    expect(stepTypes).toContain('Correct');
    expect(stepTypes).not.toContain('ValidateAfterCorrectorRepair');
  });

  it('does NOT trigger corrector-repair when no correctors are declared (regression)', async () => {
    const result = await runGen({
      ir: baseIR([]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);

    expect(stepTypes).not.toContain('Correct');
    expect(stepTypes).not.toContain('ValidateAfterCorrectorRepair');
  });

  it('handles a throwing corrector gracefully (synthesizes error issue, triggers repair)', async () => {
    const throws: CorrectorFn = () => {
      throw new Error('kaboom');
    };
    registerAppCorrectors({ throws });

    const result = await runGen({
      ir: baseIR(['throws']),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);

    // Corrector threw → synthesized error issue → feedback loop fires.
    expect(stepTypes).toContain('Correct');
    expect(stepTypes).toContain('Repair');
    expect(stepTypes).toContain('ValidateAfterCorrectorRepair');

    // The Correct step's issues should include the throw message.
    const correctStep = result.trace.steps.find((s: any) => s.type === 'Correct');
    expect(correctStep?.meta?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringContaining('kaboom'),
        }),
      ]),
    );
  });
});
