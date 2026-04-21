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

type CorrectorDecl = string | { name: string; max_attempts: number };

function baseIR(correctorNames: CorrectorDecl[]) {
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

/**
 * RED-298: per-corrector max_attempts loop + correctness fix.
 *
 * Two new behaviors on top of RED-275:
 *
 * 1. Correctness fix — after a corrector-feedback Repair that passes
 *    schema revalidation, the runner now re-runs the same corrector on
 *    the repaired output (emits `CorrectAfterRepair`). Pre-RED-298 this
 *    was silently skipped; the framework would report "healed" based
 *    on schema alone when the corrector's concern may have persisted.
 *
 * 2. `max_attempts` knob — gens can opt into 2 or 3 repair attempts for
 *    correctors that benefit from iteration (regex synthesis is the
 *    canonical case). When exhausted with errors still pending, the
 *    runner emits a terminal `CorrectAcceptedWithErrors` step so the
 *    trace reader sees "framework gave up" as an explicit state.
 */
describe('corrector multi-attempt + correctness fix (RED-298)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    _resetAppCorrectorsForTests(BUILTINS);
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('emits CorrectAfterRepair under default max_attempts: 1 (correctness fix)', async () => {
    // Even with the default 1-attempt contract, the re-run after Repair
    // happens — that's the correctness fix. The step is greppable,
    // regardless of whether the corrector healed or not.
    const reportsError: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'always-error', severity: 'error' },
      ],
    });
    registerAppCorrectors({ one_shot: reportsError });

    const result = await runGen({
      ir: baseIR([{ name: 'one_shot', max_attempts: 1 }]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    expect(stepTypes).toContain('Correct');
    expect(stepTypes).toContain('Repair');
    expect(stepTypes).toContain('ValidateAfterCorrectorRepair');
    expect(stepTypes).toContain('CorrectAfterRepair');
  });

  it('loops max_attempts: 3 when the corrector keeps flagging errors, then gives up with a terminal CorrectAcceptedWithErrors', async () => {
    // An always-failing corrector under N=3 should:
    //   - initial Correct (errors)
    //   - 3× (Repair → ValidateAfterCorrectorRepair → CorrectAfterRepair)
    //   - CorrectAcceptedWithErrors (terminal, ok:false)
    const alwaysFails: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'never heals', severity: 'error' },
      ],
    });
    registerAppCorrectors({ always_fails: alwaysFails });

    const result = await runGen({
      ir: baseIR([{ name: 'always_fails', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    expect(count('Correct')).toBe(1);
    expect(count('Repair')).toBe(3);
    expect(count('ValidateAfterCorrectorRepair')).toBe(3);
    expect(count('CorrectAfterRepair')).toBe(3);
    expect(count('CorrectAcceptedWithErrors')).toBe(1);

    const terminal = result.trace.steps.find(
      (s: any) => s.type === 'CorrectAcceptedWithErrors',
    );
    expect(terminal?.ok).toBe(false);
    expect(terminal?.meta?.corrector).toBe('always_fails');
    expect(terminal?.meta?.attempts_made).toBe(3);
    expect(terminal?.meta?.max_attempts).toBe(3);
    expect(terminal?.meta?.unhealed_issues?.[0]?.message).toContain('never heals');
  });

  it('stops looping when the corrector heals mid-loop — no CorrectAcceptedWithErrors', async () => {
    // Fails twice, then accepts on the third call. Expect only 2
    // repair iterations (the first success breaks the loop).
    let calls = 0;
    const flaky: CorrectorFn = (data) => {
      calls += 1;
      if (calls <= 2) {
        return {
          corrected: false,
          output: data,
          issues: [
            { path: '.summary', message: `still wrong (call ${calls})`, severity: 'error' },
          ],
        };
      }
      return { corrected: false, output: data, issues: [] };
    };
    registerAppCorrectors({ flaky });

    const result = await runGen({
      ir: baseIR([{ name: 'flaky', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    // Initial Correct + 2 repair iterations (call #2 fails → repair; call #3 heals).
    expect(count('Correct')).toBe(1);
    expect(count('Repair')).toBe(2);
    expect(count('CorrectAfterRepair')).toBe(2);
    expect(count('CorrectAcceptedWithErrors')).toBe(0);

    // The last CorrectAfterRepair should be ok:true (healed).
    const lastRerun = [...result.trace.steps].reverse().find(
      (s: any) => s.type === 'CorrectAfterRepair',
    );
    expect(lastRerun?.ok).toBe(true);
  });

  it('legacy Array<string> IR shape still runs (pre-RED-298 cached IRs)', async () => {
    // Bare strings on the IR should normalize to max_attempts:1 and
    // produce the same trace as the object form { name, max_attempts: 1 }.
    const reportsError: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'legacy-path-error', severity: 'error' },
      ],
    });
    registerAppCorrectors({ legacy_shape: reportsError });

    const result = await runGen({
      ir: baseIR(['legacy_shape']), // bare string, not object
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    expect(count('Repair')).toBe(1);
    expect(count('ValidateAfterCorrectorRepair')).toBe(1);
    // Correctness fix still kicks in under back-compat path.
    expect(count('CorrectAfterRepair')).toBe(1);
  });

  it('does NOT emit CorrectAcceptedWithErrors when the mutating corrector on re-run breaks schema', async () => {
    // Security-agent-flagged edge case: a mutating corrector on re-run
    // that produces schema-invalid output exits the loop before
    // correctorErrors is updated, which would otherwise spuriously
    // emit "accepted with unhealed errors" on a run that actually
    // failed on schema. The fix gates the emission on
    // !correctorSchemaBroke.
    let calls = 0;
    const mutatesIntoBadShape: CorrectorFn = (data) => {
      calls += 1;
      if (calls === 1) {
        // First call: return errors to enter the repair loop.
        return {
          corrected: false,
          output: data,
          issues: [
            { path: '.summary', message: 'trigger repair', severity: 'error' },
          ],
        };
      }
      // Second call (post-repair re-run): mutate into schema-invalid
      // shape. MockSchema requires `summary`; returning {} drops it.
      return { corrected: true, output: {}, issues: [] };
    };
    registerAppCorrectors({ mutates_bad: mutatesIntoBadShape });

    const result = await runGen({
      ir: baseIR([{ name: 'mutates_bad', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    // Must see: Correct, Repair, ValidateAfterCorrectorRepair,
    // CorrectAfterRepair, ValidateAfterCorrect (the schema break).
    expect(stepTypes).toContain('ValidateAfterCorrect');
    // Must NOT see: CorrectAcceptedWithErrors — run is failing on
    // schema, not on unhealed corrector errors.
    expect(count('CorrectAcceptedWithErrors')).toBe(0);
    expect(result.finalOk ?? result.trace?.final?.ok).toBe(false);
  });

  it('two correctors with different max_attempts run independently', async () => {
    // :a fails always with max_attempts:1 → 1 iteration + terminal step.
    // :b fails always with max_attempts:2 → 2 iterations + terminal step.
    const failA: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.a', message: 'a-err', severity: 'error' }],
    });
    const failB: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.b', message: 'b-err', severity: 'error' }],
    });
    registerAppCorrectors({ fail_a: failA, fail_b: failB });

    const result = await runGen({
      ir: baseIR([
        { name: 'fail_a', max_attempts: 1 },
        { name: 'fail_b', max_attempts: 2 },
      ]),
      schemas: { MockOutput: MockSchema },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    expect(count('Correct')).toBe(2); // one per corrector
    expect(count('Repair')).toBe(3); // 1 for a + 2 for b
    expect(count('CorrectAfterRepair')).toBe(3); // same
    expect(count('CorrectAcceptedWithErrors')).toBe(2); // both exhausted

    const terminals = result.trace.steps.filter(
      (s: any) => s.type === 'CorrectAcceptedWithErrors',
    );
    const byName = Object.fromEntries(terminals.map((t: any) => [t.meta.corrector, t]));
    expect(byName.fail_a.meta.attempts_made).toBe(1);
    expect(byName.fail_b.meta.attempts_made).toBe(2);
  });
});
