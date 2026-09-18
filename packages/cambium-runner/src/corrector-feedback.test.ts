import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGen } from './runner.js';
import { builtinCorrectors } from './correctors/index.js';
import type { CorrectorFn } from './correctors/types.js';

// RED-299: tests pass correctors via `runGen({ correctors })`, not
// via the deprecated module-global registerAppCorrectors path. Each
// test builds a local map `{ ...builtinCorrectors, ...its-own }`
// and passes it through. No per-test global teardown needed.

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
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('triggers Repair + ValidateAfterCorrectorRepair when a corrector returns error issues', async () => {
    const reports_error: CorrectorFn = (data) => ({
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

    const result = await runGen({
      ir: baseIR(['reports_error']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, reports_error },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);

    // The pre-RED-275 trace would have stopped at [Generate, Validate, Correct].
    // Post-RED-275 must include the Repair + ValidateAfterCorrectorRepair steps.
    expect(stepTypes).toContain('Correct');
    expect(stepTypes).toContain('Repair');
    expect(stepTypes).toContain('ValidateAfterCorrectorRepair');
  });

  it('does NOT trigger repair when corrector issues are all non-error severity', async () => {
    const warn_only: CorrectorFn = (data) => ({
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

    const result = await runGen({
      ir: baseIR(['warn_only']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, warn_only },
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

    const result = await runGen({
      ir: baseIR(['throws']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, throws },
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
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('emits CorrectAfterRepair under default max_attempts: 1 (correctness fix)', async () => {
    // Even with the default 1-attempt contract, the re-run after Repair
    // happens — that's the correctness fix. The step is greppable,
    // regardless of whether the corrector healed or not.
    const one_shot: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'always-error', severity: 'error' },
      ],
    });

    const result = await runGen({
      ir: baseIR([{ name: 'one_shot', max_attempts: 1 }]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, one_shot },
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
    const always_fails: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'never heals', severity: 'error' },
      ],
    });

    const result = await runGen({
      ir: baseIR([{ name: 'always_fails', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, always_fails },
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
    const result = await runGen({
      ir: baseIR([{ name: 'flaky', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, flaky },
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
    const legacy_shape: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [
        { path: '.summary', message: 'legacy-path-error', severity: 'error' },
      ],
    });

    const result = await runGen({
      ir: baseIR(['legacy_shape']), // bare string, not object
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, legacy_shape },
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
    const result = await runGen({
      ir: baseIR([{ name: 'mutates_bad', max_attempts: 3 }]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, mutates_bad: mutatesIntoBadShape },
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

  it('two correctors with different max_attempts run independently, plus #214 cross-corrector reverify of the always-failing earlier corrector', async () => {
    // :a fails always with max_attempts:1 → 1 iteration + terminal step.
    // :b fails always with max_attempts:2 → 2 iterations + terminal step.
    //
    // #214: `fail_a` is stateless (always errors regardless of input)
    // and is declared BEFORE `fail_b`. Every repair `fail_b`'s loop
    // accepts now also re-verifies `fail_a` (DEC-001) — it finds the
    // same error again every time, folds into `fail_b`'s own attempt
    // budget (DEC-002), and never heals, so at loop exit `fail_a` picks
    // up a SECOND terminal row (`regressed_during: 'fail_b'`, DEC-005)
    // in addition to the row its own loop already emitted. This is a
    // legitimate behavior change from the fix, not a bug in the test —
    // pre-#214, `fail_b`'s repairs never looked at `fail_a` again.
    const fail_a: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.a', message: 'a-err', severity: 'error' }],
    });
    const fail_b: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.b', message: 'b-err', severity: 'error' }],
    });

    const result = await runGen({
      ir: baseIR([
        { name: 'fail_a', max_attempts: 1 },
        { name: 'fail_b', max_attempts: 2 },
      ]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, fail_a, fail_b },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    expect(count('Correct')).toBe(6); // 3 declaration-order passes × 2 correctors (#266)
    expect(count('Repair')).toBe(9); // bounded: 3 passes × (1 for a + 2 for b) — DEC-002 still folds, never re-enters
    expect(count('CorrectAfterRepair')).toBe(9); // same shape as Repair

    // #214 + #266: each of fail_b's 2 accepted repairs re-verifies fail_a
    // (the one earlier corrector) once, in each of the 3 passes — 6
    // CorrectReverifyEarlier rows, all ok:false (fail_a is stateless and
    // always errors). Pre-#266 this was 2 rows: only the first pass existed.
    expect(count('CorrectReverifyEarlier')).toBe(6);
    const reverifyRows = result.trace.steps.filter((s: any) => s.type === 'CorrectReverifyEarlier');
    expect(reverifyRows.every((s: any) => s.meta?.corrector === 'fail_a')).toBe(true);
    expect(reverifyRows.every((s: any) => s.meta?.reverify_for === 'fail_b')).toBe(true);
    expect(reverifyRows.every((s: any) => s.ok === false)).toBe(true);

    // Terminal rows: fail_a's own (from its own loop, unaffected),
    // fail_b's own (unaffected), PLUS fail_a's #214 regressed-during row
    // — now 3 per declaration-order pass × 3 passes = 9, still bounded.
    expect(count('CorrectAcceptedWithErrors')).toBe(9);
    expect(count('CorrectSweepExhausted')).toBe(1); // cap hit: they never converge

    const terminals = result.trace.steps.filter(
      (s: any) => s.type === 'CorrectAcceptedWithErrors',
    );
    const ownRows = terminals.filter((t: any) => t.meta.regressed_during === undefined);
    const regressedRows = terminals.filter((t: any) => t.meta.regressed_during !== undefined);

    const byName = Object.fromEntries(ownRows.map((t: any) => [t.meta.corrector, t]));
    expect(byName.fail_a.meta.attempts_made).toBe(1);
    expect(byName.fail_b.meta.attempts_made).toBe(2);

    // #214: fail_a's regressed row is attributed to fail_a, but carries
    // fail_b's budget numbers — the budget that governed the fold
    // (DEC-002/DEC-005). One such row per pass (#266).
    expect(regressedRows).toHaveLength(3);
    expect(regressedRows[0].meta.corrector).toBe('fail_a');
    expect(regressedRows[0].meta.regressed_during).toBe('fail_b');
    expect(regressedRows[0].meta.attempts_made).toBe(2);
    expect(regressedRows[0].meta.max_attempts).toBe(2);
  });

  it('#214 (DEC-002): termination — an earlier corrector that mutates AND keeps erroring every pass still bounds the loop at the current corrector\'s own max_attempts (no cascade)', async () => {
    // Pathological pair: `mutates_and_fails` (earlier) rewrites a field
    // on every call AND always reports its own error-severity issue;
    // `fights` (current) also always errors. Both simultaneously "fight"
    // the repair loop — DEC-002's fold-into-current-budget contract must
    // still bound TOTAL iterations at `fights`'s own max_attempts (the
    // ceiling, 3) — never cascade unboundedly, and never re-enter
    // `mutates_and_fails`'s own (exhausted, max_attempts:1) loop.
    let mutateCalls = 0;
    const mutates_and_fails: CorrectorFn = (data) => {
      mutateCalls += 1;
      return {
        corrected: true,
        output: { ...data, flips: mutateCalls },
        issues: [{ path: '.a', message: 'a-always-wrong', severity: 'error' }],
      };
    };
    const fights: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.b', message: 'b-always-wrong', severity: 'error' }],
    });

    const result = await runGen({
      ir: baseIR([
        { name: 'mutates_and_fails', max_attempts: 1 },
        { name: 'fights', max_attempts: 3 },
      ]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, mutates_and_fails, fights },
    });

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => stepTypes.filter((x: string) => x === t).length;

    // mutates_and_fails's own loop (1) + fights's own loop, bounded at
    // exactly its max_attempts ceiling (3), never more — the perpetual
    // regression from mutates_and_fails does not grow the bound.
    // #266 multiplies that same bound by the fixed 3-pass cap: 3 × (1 + 3)
    // repairs — the cap is the termination argument, not convergence.
    expect(count('Repair')).toBe(3 * (1 + 3));
    expect(count('CorrectAfterRepair')).toBe(3 * (1 + 3));
    expect(count('CorrectReverifyEarlier')).toBe(3 * 3); // once per fights attempt, per pass

    const terminals = result.trace.steps.filter((s: any) => s.type === 'CorrectAcceptedWithErrors');
    // mutates_and_fails's own + fights's own + mutates_and_fails
    // regressed_during fights = 3 terminal rows per pass, never more —
    // 9 total, and CorrectSweepExhausted is the one flag row saying the
    // fixed point was cut off at the cap (#266).
    expect(terminals).toHaveLength(9);
    expect(count('CorrectSweepExhausted')).toBe(1);
    for (const t of terminals) {
      // No row's attempt count ever exceeds the RED-296 ceiling (3),
      // regardless of which corrector's budget it was folded into.
      expect(t.meta.attempts_made).toBeLessThanOrEqual(3);
      expect(t.meta.max_attempts).toBeLessThanOrEqual(3);
    }
    const regressed = terminals.find((t: any) => t.meta.regressed_during === 'fights');
    expect(regressed?.meta?.corrector).toBe('mutates_and_fails');
    expect(regressed?.meta?.attempts_made).toBe(3); // fights's budget, per DEC-002/DEC-005
  });
});

/**
 * #266 — sequential-approval staleness, FIXED. The declaration-order
 * corrector pass now repeats until no corrector mutates (hard cap 3), so
 * every corrector gets a verdict on the bytes that actually ship — at BOTH
 * sites #214 left open: the initial pass AND #214's own re-verify pass
 * (DEC-013's "design it once for both sites" instruction).
 *
 * These were the AUD-214-001 / DEC-007-ii shapes pinned as a KNOWN
 * LIMITATION (drift alarm, not endorsement). Flipping them is the ticket's
 * acceptance criterion #1 — updated deliberately, not silently re-broken.
 * Termination is a fixed cap, not convergence; the third test pins what
 * happens when correctors fight past it.
 */
describe('#266: corrector passes iterate to a bounded fixed point', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('re-checks an earlier corrector after a repair-triggered mutation (AUD-214-001 repro, now closed)', async () => {
    const corrector_a: CorrectorFn = (data: any) => ({
      corrected: false,
      output: data,
      issues: data?.a === 'REGRESSED'
        ? [{ path: '.a', message: 'a is regressed', severity: 'error' }]
        : [],
    });
    const corrector_b: CorrectorFn = (data: any) => ({
      corrected: true,
      output: { ...data, a: 'REGRESSED', b: 'fixed_b' },
      issues: [],
    });
    let cCalls = 0;
    const corrector_c: CorrectorFn = (data: any) => {
      cCalls += 1;
      return {
        corrected: false,
        output: data,
        issues: cCalls === 1
          ? [{ path: '.c', message: 'c-err', severity: 'error' }]
          : [],
      };
    };

    const result = await runGen({
      ir: baseIR([
        { name: 'corrector_a', max_attempts: 1 },
        { name: 'corrector_b', max_attempts: 1 },
        { name: 'corrector_c', max_attempts: 1 },
      ]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, corrector_a, corrector_b, corrector_c },
    });

    const steps = result.trace.steps;
    const types = steps.map((s: any) => s.type);
    const count = (t: string) => types.filter((x: string) => x === t).length;

    // Three declaration-order passes instead of one: `corrector_b` mutates
    // `a`, so pass 2 and pass 3 both go back and ask `corrector_a`.
    expect(count('Correct')).toBe(9);                        // 3 passes × 3 correctors
    expect(count('CorrectReverifyEarlier')).toBe(2);         // #214's within-pass pair, shape unchanged

    // The fingerprint `corrector_a` exists to catch is now FLAGGED twice
    // (once per re-check pass). Pre-#266 the count was 0 — that was the bug.
    const flagged = steps.filter((s: any) =>
      (s.meta?.issues ?? []).some((i: any) => i.message === 'a is regressed'),
    );
    expect(flagged.length).toBe(2);

    // Still accepted: "refuse on unhealed errors" stays the caller's job.
    // What changed is that the caller can now see it — `jq '.steps[] |
    // select(.ok == false)'` returns rows, where it returned none before.
    expect(result.ok).toBe(true);
    expect(steps.some((s: any) => s.ok === false)).toBe(true);
  });

  it('re-checks an earlier corrector after a deterministic initial-pass mutation (DEC-007-ii, no repair involved)', async () => {
    // No repair loop at all: `b` mutates `a` deterministically on its first
    // and only turn. Pre-#266 nothing ever looked at `a` again — this is the
    // half of the class DEC-007-ii deferred and DEC-013 refused to split.
    const a: CorrectorFn = (data: any) => ({
      corrected: false,
      output: data,
      issues: data?.a === 'REGRESSED'
        ? [{ path: '.a', message: 'a is regressed', severity: 'error' }]
        : [],
    });
    const b: CorrectorFn = (data: any) => ({
      corrected: true,
      output: { ...data, a: 'REGRESSED' },
      issues: [],
    });
    const c: CorrectorFn = (data: any) => ({ corrected: false, output: data, issues: [] });

    const result = await runGen({
      ir: baseIR([
        { name: 'a', max_attempts: 1 },
        { name: 'b', max_attempts: 1 },
        { name: 'c', max_attempts: 1 },
      ]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, a, b, c },
    });

    const steps = result.trace.steps;
    const types = steps.map((s: any) => s.type);
    const count = (t: string) => types.filter((x: string) => x === t).length;

    // `a` is asked again AFTER `b`'s mutation — the second and third passes
    // both flag the field `b` stamped. Pre-#266, `a`'s last verdict came
    // before the mutation existed.
    expect(count('Correct')).toBe(9);
    const lastA = steps.length - 1 - [...types].reverse().findIndex(
      (t: string, i: number) => t === 'Correct' && steps[i].meta?.correctors?.includes('a'),
    );
    const firstMutation = types.findIndex(
      (t: string, i: number) => t === 'Correct' && steps[i].meta?.correctors?.includes('b') && steps[i].meta?.corrected === true,
    );
    expect(firstMutation).toBeGreaterThan(0);
    expect(lastA).toBeGreaterThan(firstMutation);
    const regressedFlagged = steps.filter((s: any) =>
      (s.meta?.issues ?? []).some((i: any) => i.message === 'a is regressed'),
    );
    expect(regressedFlagged.length).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.output?.a).toBe('REGRESSED'); // ships, but flagged — never silently
  });

  it('caps the fixed point at three passes: fighting correctors terminate and emit one flag row', async () => {
    // `fighter` re-stamps the bad value every turn and never reports it;
    // `checker` flags it every turn. The fixed point can never converge, so
    // the bound must come from the cap: 3 passes, one `CorrectSweepExhausted`
    // row, and no unbounded cascade of repair calls.
    let n = 0;
    const fighter: CorrectorFn = (data: any) => {
      n += 1;
      return { corrected: true, output: { ...data, a: n % 2 ? 'x' : 'REGRESSED' }, issues: [] };
    };
    const checker: CorrectorFn = (data: any) => ({
      corrected: false,
      output: data,
      issues: data?.a === 'REGRESSED' ? [{ path: '.a', message: 'a bad', severity: 'error' }] : [],
    });

    const result = await runGen({
      ir: baseIR([
        { name: 'checker', max_attempts: 2 },
        { name: 'fighter', max_attempts: 1 },
      ]),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, checker, fighter },
    });

    const types = result.trace.steps.map((s: any) => s.type);
    const count = (t: string) => types.filter((x: string) => x === t).length;

    // 3 passes × 2 correctors of verification, one repair chain — bounded by
    // construction, whatever the correctors do. `max_attempts` clamp untouched.
    expect(count('Correct')).toBe(6);
    expect(count('Repair')).toBeLessThanOrEqual(3 * (2 + 1));
    expect(count('CorrectSweepExhausted')).toBe(1);
    expect(result.ok).toBe(true);
  });
});

/**
 * RED-299: per-`runGen` corrector isolation regression test.
 *
 * Pre-RED-299, `registerAppCorrectors` wrote into a module-global
 * registry that persisted across `runGen` calls. A long-lived host
 * that loaded App A's correctors, ran App A's gen, then loaded App
 * B's correctors, then ran App B's gen would see App A's correctors
 * STILL in the registry — if both apps had a corrector named `foo`,
 * the second run would use App A's version. Silent wrong-result.
 *
 * This test builds two correctors named `shared_name` with different
 * behavior (one flags error, one flags warning). Two back-to-back
 * `runGen` calls pass DIFFERENT correctors maps via `RunGenOptions`.
 * The second call's trace must reflect the second map's behavior —
 * i.e. the first call's corrector must NOT be visible.
 *
 * With the pre-RED-299 global registry, the second call would see
 * whichever corrector was registered last globally; because we never
 * used `registerAppCorrectors`, that'd be just the built-ins and the
 * `shared_name` declaration would throw "Unknown corrector." Not the
 * leakage scenario — but the test still validates the invariant by
 * confirming the passed map wins, which is the critical isolation
 * property for long-lived hosts.
 */
describe('per-runGen corrector isolation (RED-299)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('two back-to-back runGen calls with different correctors maps produce correctly scoped results', async () => {
    // Call 1: `shared_name` flags an error (triggers repair loop).
    const errorVariant: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.summary', message: 'error-variant', severity: 'error' }],
    });

    const result1 = await runGen({
      ir: baseIR(['shared_name']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, shared_name: errorVariant },
    });

    const types1 = result1.trace.steps.map((s: any) => s.type);
    expect(types1).toContain('Repair');
    expect(types1).toContain('CorrectAfterRepair');

    // Call 2: `shared_name` flags a warning only (NO repair).
    const warningVariant: CorrectorFn = (data) => ({
      corrected: false,
      output: data,
      issues: [{ path: '.summary', message: 'warning-variant', severity: 'warning' }],
    });

    const result2 = await runGen({
      ir: baseIR(['shared_name']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, shared_name: warningVariant },
    });

    const types2 = result2.trace.steps.map((s: any) => s.type);
    // If call 1's corrector leaked into call 2, we'd see Repair here.
    // With per-runGen isolation, the warning-only variant produces
    // just a clean Correct step.
    expect(types2).toContain('Correct');
    expect(types2).not.toContain('Repair');
    expect(types2).not.toContain('CorrectAfterRepair');

    // Inspect the Correct step's issues to confirm the right corrector ran.
    const correct2 = result2.trace.steps.find((s: any) => s.type === 'Correct');
    expect(correct2?.meta?.issues?.[0]?.message).toBe('warning-variant');
    expect(correct2?.meta?.issues?.[0]?.severity).toBe('warning');
  });

  it('a corrector omitted from the second call is not found (proves no leakage)', async () => {
    // Call 1 has corrector `only_in_first`. Call 2 declares the same
    // corrector name but passes a map WITHOUT it → runCorrectorPipeline
    // throws "Unknown corrector." Pre-RED-299 the global registry would
    // have retained it and the call would have succeeded silently.
    const only_in_first: CorrectorFn = (data) => ({
      corrected: false, output: data, issues: [],
    });

    const result1 = await runGen({
      ir: baseIR(['only_in_first']),
      schemas: { MockOutput: MockSchema },
      correctors: { ...builtinCorrectors, only_in_first },
    });
    expect(result1.ok).toBe(true);

    // Call 2 omits `only_in_first`. Expect an Unknown-corrector error.
    await expect(
      runGen({
        ir: baseIR(['only_in_first']),
        schemas: { MockOutput: MockSchema },
        correctors: { ...builtinCorrectors }, // no `only_in_first`
      }),
    ).rejects.toThrow(/Unknown corrector.*only_in_first/);
  });
});
