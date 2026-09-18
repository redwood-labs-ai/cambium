/**
 * #275: `mode :decision` — runner dispatch + handler + post-Generate tail
 * (DEC-007/008/009/010/011/014).
 *
 * Drives `runGen` against a hand-built decision IR (same shape STEP-001's
 * compiler emits — see the `TicketRouter` example in PLAN-275) with fake
 * `decide()`-only providers injected via `_testProviders` (RED-421), the
 * same real-loop-no-live-network pattern `multi-provider-fallback.test.ts`
 * uses for `generateText`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGen } from './runner.js';
import { runPipelineFromIr } from './pipeline.js';
import { ProviderHttpError } from './providers/types.js';
import type { CambiumProvider } from './providers/types.js';

// ── IR fixture ──────────────────────────────────────────────────────────
// Mirrors the IR STEP-001's compiler emits for the TicketRouter example
// (PLAN-275): mode: 'decision', decision.questions, and a compiler-added
// closed `_decision` schema property.

function makeDecisionIR(
  modelId: string,
  opts?: {
    fallbacks?: string[];
    toolsAllowed?: string[];
    signals?: any[];
    triggers?: any[];
    context?: Record<string, any>;
  },
): any {
  return {
    version: '0.2',
    entry: { class: 'TicketRouter', method: 'route', source: 'ticket_router.cmb.rb' },
    model: {
      id: modelId,
      ...(opts?.fallbacks ? { fallbacks: opts.fallbacks } : {}),
    },
    system: 'You are a router.',
    mode: 'decision',
    decision: {
      questions: {
        department: {
          kind: 'choice',
          instructions: 'Which team should handle this ticket?',
          options: {
            billing: 'Payment, invoice, or subscription issues',
            technical: 'Bugs, errors, or integration failures',
            sales: 'Pricing, plans, or account questions',
          },
        },
        is_urgent: { kind: 'boolean', instructions: 'The ticket conveys urgency or time-sensitivity' },
      },
    },
    policies: {
      tools_allowed: opts?.toolsAllowed ?? [],
      correctors: [],
      constraints: {},
      grounding: null,
      security: null,
      budget: null,
      memory: [],
      memory_pools: {},
      memory_write_via: null,
      log: [],
      log_profiles: [],
      schedules: [],
    },
    reads_trace_of: null,
    returnSchema: {
      type: 'object',
      properties: {
        department: {
          type: 'string',
          enum: ['billing', 'technical', 'sales'],
          description: 'Which team should handle this ticket?',
        },
        is_urgent: { type: 'boolean', description: 'The ticket conveys urgency or time-sensitivity' },
        // #275 DEC-009a/DEC-009b: probabilities keeps `properties`
        // (documentation + typing) but drops `required`/
        // `additionalProperties: false` on that sub-object — the option
        // keys are Cambium's, the MAP is the vendor's. `confidence` stays
        // declared but is not `required` (DEC-009b) — the vendor shows it
        // in every documented example but does not guarantee it in
        // writing. The boolean entry is the vendor's own single
        // `{ probability }` number, no synthesized complement.
        _decision: {
          type: 'object',
          required: ['department', 'is_urgent'],
          additionalProperties: false,
          properties: {
            department: {
              type: 'object',
              required: ['probabilities'],
              additionalProperties: false,
              properties: {
                confidence: { type: 'number' },
                probabilities: {
                  type: 'object',
                  properties: {
                    billing: { type: 'number' },
                    technical: { type: 'number' },
                    sales: { type: 'number' },
                  },
                },
              },
            },
            is_urgent: {
              type: 'object',
              required: ['probability'],
              additionalProperties: false,
              properties: {
                probability: { type: 'number' },
              },
            },
          },
        },
      },
      required: ['department', 'is_urgent', '_decision'],
      additionalProperties: false,
      $id: 'TicketRouterOutput',
    },
    context: opts?.context ?? { document: 'Stripe connection ticket text' },
    enrichments: [],
    signals: opts?.signals ?? [],
    triggers: opts?.triggers ?? [],
    steps: [
      { id: 'generate_1', type: 'Generate', prompt: 'Route this support ticket', with: { context: '' }, returns: null },
    ],
  };
}

const SCHEMAS = {};

// ── fake decide()-only providers ───────────────────────────────────────

function fakeDecideProvider(handlers: Partial<Pick<CambiumProvider, 'decide'>>): CambiumProvider {
  return {
    name: 'fake',
    supportsDocuments: false,
    async generateText() {
      throw new Error('fakeDecideProvider: generateText not configured');
    },
    async generateWithTools() {
      throw new Error('fakeDecideProvider: generateWithTools not configured');
    },
    ...handlers,
  };
}

function succeedingDecideProvider(answers: Record<string, any>, usage?: any): CambiumProvider {
  return fakeDecideProvider({
    async decide() {
      return { answers, usage };
    },
  });
}

function throwingDecideProvider(makeErr: () => Error): CambiumProvider {
  return fakeDecideProvider({
    async decide() {
      throw makeErr();
    },
  });
}

const BILLING_ANSWERS = {
  department: { kind: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0, sales: 0 } },
  is_urgent: { kind: 'boolean', probability: 0 },
};

afterEach(() => {
  delete process.env.CAMBIUM_ALLOW_MOCK;
});

// ── (a) happy path ────────────────────────────────────────────────────

describe('#275 mode :decision — happy path', () => {
  it('answers land at the top level with a _decision envelope; Generate meta carries mode + decision', async () => {
    const result = await runGen({
      ir: makeDecisionIR('fake:jev'),
      schemas: SCHEMAS,
      _testProviders: new Map([
        ['fake', succeedingDecideProvider(BILLING_ANSWERS, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })],
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      department: 'billing',
      is_urgent: false,
      _decision: {
        department: { confidence: 1, probabilities: { billing: 1, technical: 0, sales: 0 } },
        is_urgent: { probability: 0 },
      },
    });

    const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(genStep.ok).toBe(true);
    expect(genStep.meta.mode).toBe('decision');
    expect(genStep.meta.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(genStep.meta.decision.questions).toBe(2);
    expect(genStep.meta.decision.answers.department).toEqual({
      value: 'billing',
      confidence: 1,
      probabilities: { billing: 1, technical: 0, sales: 0 },
    });
    expect(genStep.meta.decision.answers.is_urgent).toEqual({
      value: false,
      probability: 0,
    });
  });
});

// ── (b) boolean threshold ─────────────────────────────────────────────

describe('#275 mode :decision — boolean threshold', () => {
  it('probability exactly 0.5 → true; 0.49 → false', async () => {
    for (const [probability, expected] of [[0.5, true], [0.49, false]] as const) {
      const result = await runGen({
        ir: makeDecisionIR('fake:jev'),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fake', succeedingDecideProvider({
            department: BILLING_ANSWERS.department,
            is_urgent: { kind: 'boolean', probability },
          })],
        ]),
      });
      expect(result.ok, `probability ${probability}`).toBe(true);
      expect(result.output.is_urgent, `probability ${probability}`).toBe(expected);
    }
  });
});

// ── (c)/(d)/(e) fallback classification ───────────────────────────────

describe('#275 mode :decision — provider fallback', () => {
  it('(c) transient primary failure (529) → ModelFallback step → fallback answers', async () => {
    const result = await runGen({
      ir: makeDecisionIR('fakeprimary:jev', { fallbacks: ['fakefallback:jev'] }),
      schemas: SCHEMAS,
      _testProviders: new Map([
        ['fakeprimary', throwingDecideProvider(() => new ProviderHttpError(529, 'fakeprimary error: HTTP 529'))],
        ['fakefallback', succeedingDecideProvider({
          department: { kind: 'choice', choice: 'technical', confidence: 0.8, probabilities: { billing: 0.1, technical: 0.8, sales: 0.1 } },
          is_urgent: { kind: 'boolean', probability: 1 },
        })],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.output.department).toBe('technical');
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    expect(fallbackSteps).toHaveLength(1);
    expect(fallbackSteps[0].meta.error_class).toBe('transient');
    expect(fallbackSteps[0].meta.attempted).toBe('fakeprimary:jev');
    expect(fallbackSteps[0].meta.fallback_to).toBe('fakefallback:jev');
  });

  it('(d) deterministic primary failure (422) → no ModelFallback, run fails', async () => {
    let fallbackCalled = false;
    const watchedFallback: CambiumProvider = fakeDecideProvider({
      async decide() {
        fallbackCalled = true;
        return { answers: BILLING_ANSWERS };
      },
    });
    await expect(
      runGen({
        ir: makeDecisionIR('fakeprimary:jev', { fallbacks: ['fakefallback:jev'] }),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fakeprimary', throwingDecideProvider(() => new ProviderHttpError(422, 'fakeprimary error: HTTP 422'))],
          ['fakefallback', watchedFallback],
        ]),
      }),
    ).rejects.toThrow(/HTTP 422/);
    expect(fallbackCalled).toBe(false);
  });

  it('(e) fallback provider lacking decide() → error names the prefix, no further candidates tried', async () => {
    let thirdCalled = false;
    const thirdProvider: CambiumProvider = fakeDecideProvider({
      async decide() {
        thirdCalled = true;
        return { answers: BILLING_ANSWERS };
      },
    });
    // A text-only provider (like ollama/omlx): no `decide` at all.
    const textOnlyFallback: CambiumProvider = {
      name: 'fakefallback',
      supportsDocuments: false,
      async generateText() {
        return { text: '{}' };
      },
      async generateWithTools() {
        return { message: { content: '{}' } };
      },
    };
    await expect(
      runGen({
        ir: makeDecisionIR('fakeprimary:jev', { fallbacks: ['fakefallback:jev', 'fakethird:jev'] }),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fakeprimary', throwingDecideProvider(() => new ProviderHttpError(503, 'fakeprimary error: HTTP 503'))],
          ['fakefallback', textOnlyFallback],
          ['fakethird', thirdProvider],
        ]),
      }),
    ).rejects.toThrow(/does not support mode :decision.*no decide\(\)/);
    expect(thirdCalled).toBe(false);
  });
});

// ── (f) --mock ────────────────────────────────────────────────────────

describe('#275 mode :decision — --mock (DEC-014)', () => {
  it('mock output is byte-stable across two runs and matches the schema-mock shape', async () => {
    const r1 = await runGen({ ir: makeDecisionIR('typesafe:jev-latest'), schemas: SCHEMAS, mock: true });
    const r2 = await runGen({ ir: makeDecisionIR('typesafe:jev-latest'), schemas: SCHEMAS, mock: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.output).toEqual(r2.output);
    expect(r1.output).toEqual({
      department: 'billing',
      is_urgent: false,
      _decision: {
        department: { confidence: 1, probabilities: { billing: 1, technical: 0, sales: 0 } },
        is_urgent: { probability: 0 },
      },
    });
  });
});

// ── AUD-275-001 / DEC-007a: --mock cannot green-light a provider that ──
// cannot decide (the capability gate now runs above the mock branch too)

describe('#275 AUD-275-001/DEC-007a — --mock capability gate', () => {
  it('a real built-in text provider (omlx:, no decide()) fails under --mock with the named error', async () => {
    await expect(
      runGen({ ir: makeDecisionIR('omlx:qwen3.5-32b'), schemas: SCHEMAS, mock: true }),
    ).rejects.toThrow(/Provider "omlx" does not support mode :decision \(no decide\(\)\)/);
  });

  it('an _testProviders fake without decide() still fails at dispatch under --mock', async () => {
    const textOnlyFake: CambiumProvider = {
      name: 'fake',
      supportsDocuments: false,
      async generateText() { return { text: '{}' }; },
      async generateWithTools() { return { message: { content: '{}' } }; },
    };
    await expect(
      runGen({
        ir: makeDecisionIR('fake:jev'),
        schemas: SCHEMAS,
        mock: true,
        _testProviders: new Map([['fake', textOnlyFake]]),
      }),
    ).rejects.toThrow(/Provider "fake" does not support mode :decision \(no decide\(\)\)/);
  });

  it('an unknown prefix keeps today\'s mock behaviour unchanged (gate only fires on a resolvable provider)', async () => {
    const result = await runGen({ ir: makeDecisionIR('nosuchprovider:x'), schemas: SCHEMAS, mock: true });
    expect(result.ok).toBe(true);
    expect(result.output.department).toBe('billing');
  });
});

// ── AUD-275-006: an option key named `__proto__` under --mock ──────────

describe('#275 AUD-275-006 — __proto__ option key under --mock', () => {
  it('becomes a real own property, not a silently-dropped prototype assignment', async () => {
    const ir = makeDecisionIR('typesafe:jev-latest');
    // `{ __proto__: … }` as an object *literal* is spec-special-cased (it
    // sets the prototype, never an own property) — exactly the class of
    // bug this test is pinning. JSON.parse uses CreateDataProperty
    // internally, so it's the one construction that reproduces a genuine
    // own `__proto__` key, matching how the real (JSON.parse'd) provider
    // response reaches the handler in production.
    ir.decision.questions.department.options = JSON.parse('{"__proto__":"p","constructor":"c","toString":"t"}');
    ir.returnSchema.properties.department.enum = ['__proto__', 'constructor', 'toString'];
    ir.returnSchema.properties._decision.properties.department.properties.probabilities.properties = JSON.parse(
      '{"__proto__":{"type":"number"},"constructor":{"type":"number"},"toString":{"type":"number"}}',
    );

    const result = await runGen({ ir, schemas: SCHEMAS, mock: true });

    expect(result.ok).toBe(true);
    expect(result.output.department).toBe('__proto__');
    expect(Object.prototype.hasOwnProperty.call(result.output._decision.department.probabilities, '__proto__')).toBe(true);
    expect(result.output._decision.department.probabilities.__proto__).toBe(1);
    // Object.prototype itself must be untouched.
    expect(Object.prototype.hasOwnProperty.call({}, 'department')).toBe(false);
  });
});

// ── AUD-275-003/004/DEC-009b: a malformed decide() result never escapes ──
// runGen as an opaque throw once decide() has returned — it lands as a
// Generate{ok:false} row and falls through the existing validation tail.
// Amendment 2's DEC-009b supersedes Amendment 1's "the thrown error
// propagates" resolution for this class: only a decide() call that
// ITSELF throws (the (d)/(e) fallback-classification tests above) still
// propagates unhandled. NaN/Infinity are still rejected as non-finite
// wherever a number is required.

/** A decide() that returns successfully but with a malformed envelope —
 *  the DEC-009b "Generate{ok:false} + validation tail" class, as opposed
 *  to `throwingDecideProvider` (decide() itself throws). Tracks whether
 *  generateText/generateWithTools were called, so a test can prove the
 *  LLM is never invoked to patch a decision-mode answer. */
function malformedDecideProvider(answers: any, usage?: any): { provider: CambiumProvider; textCalled: () => boolean } {
  let called = false;
  const provider: CambiumProvider = {
    name: 'fake',
    supportsDocuments: false,
    async generateText() { called = true; return { text: '{}' }; },
    async generateWithTools() { called = true; return { message: { content: '{}' } }; },
    async decide() { return { answers, usage }; },
  };
  return { provider, textCalled: () => called };
}

/** The common shape of a DEC-009b guard failure: Generate{ok:false,
 *  errors}, Validate{ok:false} ("No data to validate"), a terminal
 *  Repair, and the whole run ends ok:false/failureKind:'validation' — the
 *  same tail an out-of-set choice takes (DEC-011). */
function expectDecisionGuardFailure(result: any, messagePattern: RegExp) {
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe('validation');
  const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
  expect(genStep.ok).toBe(false);
  expect(genStep.meta).toMatchObject({ model_used: 'fake:jev', mode: 'decision' });
  expect(genStep.errors?.[0]?.message).toMatch(messagePattern);
  const validateStep = result.trace.steps.find((s: any) => s.type === 'Validate');
  expect(validateStep).toMatchObject({ ok: false, errors: [{ message: 'No data to validate' }] });
  const repairStep = result.trace.steps.find((s: any) => s.type === 'Repair');
  expect(repairStep).toMatchObject({ ok: false, meta: { reason: 'decision_mode', deterministic: true } });
}

describe('#275 AUD-275-003/004/DEC-009b — decide() trust-boundary guards land as Generate{ok:false}, not a throw', () => {
  it('a missing answer for a declared question fails validation naming the question; generateText is never called', async () => {
    const { provider, textCalled } = malformedDecideProvider({ department: BILLING_ANSWERS.department }); // is_urgent missing
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /decide\(\): provider "fake:jev" returned no answer for question 'is_urgent'/);
    expect(textCalled()).toBe(false);
  });

  it('answers shaped as an array instead of a map fails the same named way, not a raw TypeError', async () => {
    const { provider, textCalled } = malformedDecideProvider([BILLING_ANSWERS.department, BILLING_ANSWERS.is_urgent]);
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /decide\(\): provider "fake:jev" returned no answer for question/);
    expect(textCalled()).toBe(false);
  });

  it('a kind-mismatched answer (choice question, no .choice string) fails validation naming the question', async () => {
    const { provider, textCalled } = malformedDecideProvider({
      department: { kind: 'boolean', probability: 0.5 }, // wrong shape for a choice question
      is_urgent: BILLING_ANSWERS.is_urgent,
    });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /question 'department' expects \{ kind: 'choice'/);
    expect(textCalled()).toBe(false);
  });

  it('NaN confidence fails validation with a finite-number message instead of persisting as null', async () => {
    const { provider } = malformedDecideProvider({
      department: { ...BILLING_ANSWERS.department, confidence: NaN },
      is_urgent: BILLING_ANSWERS.is_urgent,
    });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /question 'department' confidence must be a finite number, got NaN/);
  });

  it('Infinity boolean probability fails validation with a finite-number message', async () => {
    const { provider } = malformedDecideProvider({
      department: BILLING_ANSWERS.department,
      is_urgent: { kind: 'boolean', probability: Infinity },
    });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /question 'is_urgent' probability must be a finite number, got Infinity/);
  });

  it('a NaN value inside a DECLARED probabilities key fails validation naming the option key', async () => {
    const { provider } = malformedDecideProvider({
      department: { kind: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: NaN, sales: 0 } },
      is_urgent: BILLING_ANSWERS.is_urgent,
    });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });
    expectDecisionGuardFailure(result, /question 'department' probabilities\.technical must be a finite number, got NaN/);
  });
});

// ── AUD-275-015/DEC-009b: confidence is optional on a choice answer ─────

describe('#275 AUD-275-015/DEC-009b — confidence is optional on a choice answer', () => {
  it('confidence absent → ok:true, no confidence key in the output envelope or the trace', async () => {
    const { confidence, ...departmentWithoutConfidence } = BILLING_ANSWERS.department as any;
    const provider = succeedingDecideProvider({ department: departmentWithoutConfidence, is_urgent: BILLING_ANSWERS.is_urgent });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.output._decision.department, 'confidence')).toBe(false);
    expect(result.output._decision.department.probabilities).toEqual({ billing: 1, technical: 0, sales: 0 });

    const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(Object.prototype.hasOwnProperty.call(genStep.meta.decision.answers.department, 'confidence')).toBe(false);
  });

  it('an undeclared, non-numeric key inside probabilities passes through untouched (DEC-009a, not re-checked by DEC-009b)', async () => {
    const provider = succeedingDecideProvider({
      department: {
        kind: 'choice', choice: 'billing', confidence: 1,
        probabilities: { billing: 1, technical: 0, sales: 0, _model_version: 'v2' } as any,
      },
      is_urgent: BILLING_ANSWERS.is_urgent,
    });
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    expect(result.output._decision.department.probabilities._model_version).toBe('v2');
  });
});

// ── AUD-275-016: a malformed usage is dropped, not fatal ─────────────────

describe('#275 AUD-275-016 — a malformed usage is dropped rather than failing the run', () => {
  it('a partial usage object (missing prompt_tokens/completion_tokens) is omitted from Generate meta; the run still succeeds', async () => {
    const provider = succeedingDecideProvider(BILLING_ANSWERS, { total_tokens: 12 }); // off-contract, plausible from a custom provider
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(genStep.meta.usage).toBeUndefined();
  });

  // AUD-275-018: `usage: null` (the natural shape of `usage: body.usage`
  // against a vendor that sends JSON `null`) hit the `!== undefined`
  // guard's blind spot and threw a bare TypeError out of runGen with zero
  // trace rows — the exact failure shape this whole block exists to close.
  it('AUD-275-018: usage: null is dropped like any other malformed usage — no throw, run proceeds, no usage in meta', async () => {
    const provider = succeedingDecideProvider(BILLING_ANSWERS, null);
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(genStep).toBeDefined();
    expect(genStep.ok).toBe(true);
    expect(genStep.meta.usage).toBeUndefined();
  });
});

// AUD-275-019: the DEC-009b error path carries a well-formed usage into
// the failure meta, so a billed call is still accounted for even though
// the envelope was malformed.
describe('#275 AUD-275-019 — a well-formed usage survives onto the Generate{ok:false} error path', () => {
  it('a malformed envelope with well-formed usage: Generate.ok is false but meta.usage.total_tokens is preserved', async () => {
    const { provider } = malformedDecideProvider(
      { department: { ...BILLING_ANSWERS.department, confidence: NaN }, is_urgent: BILLING_ANSWERS.is_urgent },
      { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 },
    );
    const result = await runGen({ ir: makeDecisionIR('fake:jev'), schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(false);
    const genStep = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(genStep.ok).toBe(false);
    expect(genStep.meta.usage.total_tokens).toBe(1000);
  });
});

// ── (g) fail-closed validation ────────────────────────────────────────

describe('#275 mode :decision — validation failure is terminal (DEC-011)', () => {
  it('an out-of-set choice that slips past the provider fails validation deterministically, without calling generateText', async () => {
    let generateTextCalled = false;
    const badProvider: CambiumProvider = {
      name: 'fake',
      supportsDocuments: false,
      async generateText() {
        generateTextCalled = true;
        return { text: '{}' };
      },
      async generateWithTools() {
        generateTextCalled = true;
        return { message: { content: '{}' } };
      },
      async decide() {
        return {
          answers: {
            department: {
              kind: 'choice',
              choice: 'refunds', // not one of billing/technical/sales
              confidence: 1,
              probabilities: { billing: 0, technical: 0, sales: 0, refunds: 1 },
            },
            is_urgent: { kind: 'boolean', probability: 0 },
          },
        };
      },
    };

    const result = await runGen({
      ir: makeDecisionIR('fake:jev'),
      schemas: SCHEMAS,
      _testProviders: new Map([['fake', badProvider]]),
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('validation');
    const repairStep = result.trace.steps.find((s: any) => s.type === 'Repair');
    expect(repairStep).toMatchObject({ ok: false, meta: { reason: 'decision_mode', deterministic: true } });
    expect(generateTextCalled).toBe(false);
  });
});

// ── (h) document gate ─────────────────────────────────────────────────

describe('#275 mode :decision — document gate (DEC-007)', () => {
  it('a typed document envelope in context fails fast before dispatch (Jev is text-only)', async () => {
    const ir = makeDecisionIR('typesafe:jev-latest');
    ir.context = { doc: { kind: 'base64_image', data: 'AAAA', media_type: 'image/png' } };
    await expect(runGen({ ir, schemas: SCHEMAS })).rejects.toThrow(/does not support native document input/);
  });
});

// ── (i) state assembly ────────────────────────────────────────────────

describe('#275 mode :decision — state assembly (DEC-008)', () => {
  it('`_`-prefixed context keys never reach state.context; empty ir.system omits state.system', async () => {
    let capturedState: any;
    const provider: CambiumProvider = fakeDecideProvider({
      async decide(opts) {
        capturedState = opts.state;
        return { answers: BILLING_ANSWERS };
      },
    });
    const ir = makeDecisionIR('fake:jev', {
      context: { document: 'visible text', _pipeline_arg: 'hidden', _x: 'also hidden' },
    });
    ir.system = '';

    const result = await runGen({ ir, schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    expect(capturedState.system).toBeUndefined();
    expect(capturedState.context).toEqual({ document: 'visible text' });
    expect(capturedState.task).toBe('Route this support ticket');
  });
});

// ── (j) extract + on ──────────────────────────────────────────────────

describe('#275 mode :decision — extract + on (confidence is readable, not acted on)', () => {
  it('a numeric decision value can drive a deterministic tool_call trigger', async () => {
    const provider = succeedingDecideProvider({
      department: { kind: 'choice', choice: 'billing', confidence: 0.75, probabilities: { billing: 0.75, technical: 0.15, sales: 0.1 } },
      is_urgent: { kind: 'boolean', probability: 0 },
    });
    const ir = makeDecisionIR('fake:jev', {
      toolsAllowed: ['calculator'],
      signals: [{ name: 'confidence', type: 'number', path: '_decision.department.confidence' }],
      triggers: [{ on: 'confidence', action: 'tool_call', tool: 'calculator', args: { operation: 'avg' }, target: 'confidence_check' }],
    });

    const result = await runGen({ ir, schemas: SCHEMAS, _testProviders: new Map([['fake', provider]]) });

    expect(result.ok).toBe(true);
    expect(result.output.confidence_check).toBe(0.75);
  });
});

// ── pipeline: reading a decision gen's confidence (goal 3) ────────────
//
// OQ-005: pipeline_runtime.test.ts's `output do … end` coverage drives a
// CLI spawn, not `runPipelineFromIr` in-process; no existing harness
// fits "a two-operator pipeline under mock, called directly" without
// building a new one — so this drives `runPipelineFromIr` directly
// against the real, in-tree `TicketTriage` pipeline (DEC-016), compiled
// for real via `ruby/cambium/compile.rb` like the golden corpus does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const COMPILE_RB = join(REPO_ROOT, 'ruby/cambium/compile.rb');
const TICKET_TRIAGE_PIPELINE = join(REPO_ROOT, 'packages/cambium/app/pipelines/ticket_triage.pipeline.rb');

describe('#275 mode :decision — pipeline reads a decision gen\'s confidence (goal 3)', () => {
  it('bind(:route)._decision.department.confidence resolves in the pipeline output under --mock', async () => {
    const irJson = execFileSync('ruby', [COMPILE_RB, TICKET_TRIAGE_PIPELINE], { encoding: 'utf8', cwd: REPO_ROOT });
    const ir = JSON.parse(irJson).triage;
    ir.context._pipeline_arg = 'Stripe webhook connection ticket text';

    const result = await runPipelineFromIr({ ir, cwd: REPO_ROOT, compileRb: COMPILE_RB, mock: true });

    try {
      expect(result.ok, result.errorMessage).toBe(true);
      expect(result.output).toEqual({ department: 'billing', confidence: 1 });
    } finally {
      if (result.runDir) rmSync(result.runDir, { recursive: true, force: true });
    }
  });
});
