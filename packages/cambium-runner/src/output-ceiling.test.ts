/**
 * RED-174: output-ceiling exhaustion is its own failure, on every provider.
 *
 * Hitting `max_tokens` truncates the completion mid-JSON. The runner used to
 * see only text that would not parse, report a parse error, and feed the
 * fragment to the repair loop — which regenerated under the SAME ceiling and
 * truncated again, burning every attempt before failing as `validation`.
 * Nothing in the trace named the ceiling.
 *
 * The signal existed on every provider and was discarded at a different layer
 * in each case; `normalizeStopReason` is now the single mapping.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeStopReason,
  type StopReason,
} from './providers/types.js';
import {
  detectOutputCeiling,
  appliedCeiling,
  ceilingMessage,
  DEFAULT_MAX_TOKENS,
} from './step-handlers.js';
import { runGen } from './runner.js';
import type { CambiumProvider } from './providers/types.js';

describe('normalizeStopReason — one mapping for every provider dialect', () => {
  // The three native spellings of "you hit the ceiling", one per built-in.
  it.each([
    ['max_tokens', 'anthropic'],
    ['length', 'openai-compatible / omlx'],
    ['length', 'ollama done_reason'],
  ])('maps %s (%s) to length', (raw) => {
    expect(normalizeStopReason(raw)).toBe<StopReason>('length');
  });

  it.each(['end_turn', 'stop', 'stop_sequence'])('maps %s to stop', (raw) => {
    expect(normalizeStopReason(raw)).toBe<StopReason>('stop');
  });

  it.each(['tool_use', 'tool_calls'])('maps %s to tool_use', (raw) => {
    expect(normalizeStopReason(raw)).toBe<StopReason>('tool_use');
  });

  it('maps an unrecognized non-empty value to other', () => {
    expect(normalizeStopReason('content_filter')).toBe<StopReason>('other');
  });

  it('leaves absent/empty undefined, so "said nothing" stays distinguishable', () => {
    // This is load-bearing: the usage heuristic only runs when the provider
    // reported nothing. A provider that said 'stop' is believed.
    expect(normalizeStopReason(undefined)).toBeUndefined();
    expect(normalizeStopReason('')).toBeUndefined();
    expect(normalizeStopReason(null)).toBeUndefined();
    expect(normalizeStopReason(42)).toBeUndefined();
  });
});

describe('appliedCeiling — which limit was actually in force', () => {
  it('reports a declared max_tokens as declared', () => {
    expect(appliedCeiling({ model: { max_tokens: 4000 } }))
      .toEqual({ ceiling: 4000, declared: true });
  });

  it('reports the default as undeclared', () => {
    // The error text leans on this: a user who never set max_tokens has no
    // reason to know 1200 exists.
    expect(appliedCeiling({ model: {} }))
      .toEqual({ ceiling: DEFAULT_MAX_TOKENS, declared: false });
  });
});

describe('detectOutputCeiling', () => {
  const ir = { model: { max_tokens: 1000 } };

  it('trusts a reported length even when the fragment parsed', () => {
    // extractJsonObject slices to the last `}`, so a truncated response can
    // yield a *prefix* object that validates while silently missing content.
    // "The provider says it cut this off" beats "it happens to parse".
    const c = detectOutputCeiling({ stopReason: 'length' }, ir, /* parseFailed */ false);
    expect(c).toMatchObject({ hit: true, source: 'reported', ceiling: 1000 });
  });

  it('does not fire when the provider reported a normal stop', () => {
    expect(detectOutputCeiling({ stopReason: 'stop' }, ir, true)).toBeNull();
  });

  it('does not fire mid-agentic on tool_use', () => {
    expect(detectOutputCeiling({ stopReason: 'tool_use' }, ir, false)).toBeNull();
  });

  it('infers a ceiling from usage when the provider reported nothing', () => {
    const c = detectOutputCeiling(
      { usage: { completion_tokens: 1000 } as any }, ir, true);
    expect(c).toMatchObject({ hit: true, source: 'inferred', ceiling: 1000 });
  });

  it('never infers on a successful parse — a false positive cannot fail a good run', () => {
    // The heuristic is gated on parseFailed precisely so that a completion
    // which legitimately ends at the cap is not retroactively failed.
    expect(detectOutputCeiling(
      { usage: { completion_tokens: 1000 } as any }, ir, /* parseFailed */ false,
    )).toBeNull();
  });

  it('does not infer below the ceiling', () => {
    expect(detectOutputCeiling(
      { usage: { completion_tokens: 999 } as any }, ir, true)).toBeNull();
  });

  it('does not infer when the provider spoke, even if usage is at the cap', () => {
    // A provider that said 'stop' is believed over the heuristic.
    expect(detectOutputCeiling(
      { stopReason: 'stop', usage: { completion_tokens: 1000 } as any }, ir, true,
    )).toBeNull();
  });

  it('handles a missing provider result without throwing', () => {
    expect(detectOutputCeiling(undefined, ir, true)).toBeNull();
  });
});

describe('ceilingMessage', () => {
  it('names the limit and that it came from the gen', () => {
    const msg = ceilingMessage(
      { hit: true, source: 'reported', ceiling: 4000, declared: true }, 'anthropic:x');
    expect(msg).toContain('4000');
    expect(msg).toContain('declared');
    expect(msg).toContain('anthropic:x');
  });

  it('says the limit was the default when the gen never declared one', () => {
    const msg = ceilingMessage(
      { hit: true, source: 'inferred', ceiling: DEFAULT_MAX_TOKENS, declared: false,
        completionTokens: 1200 }, 'omlx:y');
    expect(msg).toContain('no value declared');
    expect(msg).toContain(String(DEFAULT_MAX_TOKENS));
  });

  it('does not call a truncated fragment malformed JSON', () => {
    // The entire point: the old failure blamed the model's JSON formatting
    // for a limit the runner itself imposed.
    const msg = ceilingMessage(
      { hit: true, source: 'reported', ceiling: 100, declared: true }, 'm');
    expect(msg).toMatch(/fragment, not malformed JSON/);
    expect(msg).toMatch(/max_tokens/);
  });
});

// ── End-to-end: the behavior the issue is actually about ────────────────

/** IR for a single-step gen with an inline schema (no contracts module). */
function ceilingIR(maxTokens?: number): any {
  return {
    version: '0.2',
    entry: { class: 'CeilingGen', method: 'analyze', source: 'g.cmb.rb' },
    model: { id: 'fakeprov:m', temperature: 0.1, ...(maxTokens != null ? { max_tokens: maxTokens } : {}) },
    system: 'test system',
    mode: 'single',
    policies: { tools_allowed: [], correctors: [], constraints: {}, grounding: null },
    returnSchema: {
      $id: 'CeilingOutput',
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    context: { document: 'doc' },
    enrichments: [], signals: [], triggers: [],
    steps: [{ id: 'gen_1', type: 'Generate', prompt: 'analyze' }],
  };
}

/** A provider that truncates mid-JSON and reports why, counting its calls. */
function truncatingProvider(opts: { report: boolean; completionTokens?: number }) {
  const calls = { n: 0 };
  const provider: CambiumProvider = {
    name: 'fakeprov',
    supportsDocuments: false,
    async generateText() {
      calls.n += 1;
      return {
        // Cut off mid-object, exactly as a real ceiling hit looks.
        text: '{"summary": "the quick brown fox jumped over the la',
        ...(opts.report ? { stopReason: 'length' as const } : {}),
        ...(opts.completionTokens != null
          ? { usage: { prompt_tokens: 5, completion_tokens: opts.completionTokens, total_tokens: 5 + opts.completionTokens } }
          : {}),
      };
    },
    async generateWithTools() { throw new Error('not used'); },
  };
  return { provider, calls };
}

async function runWith(provider: CambiumProvider, ir: any) {
  return runGen({
    ir, schemas: {}, persistRun: false,
    _testProviders: new Map([['fakeprov', provider]]),
  } as any);
}

describe('RED-174 end-to-end — a ceiling is not a validation failure', () => {
  it('fails with failureKind output_ceiling, not validation', async () => {
    const { provider } = truncatingProvider({ report: true });
    const result = await runWith(provider, ceilingIR(100));
    expect(result.ok).toBe(false);
    // Before RED-174 this was 'validation' — but nothing was validated,
    // because nothing complete was ever produced.
    expect(result.failureKind).toBe('output_ceiling');
  });

  it('does NOT enter the repair loop — repair cannot move the ceiling', async () => {
    // The core waste the issue describes: handleRepair reads the same
    // ir.model.max_tokens, so every attempt truncates at the same place.
    const { provider, calls } = truncatingProvider({ report: true });
    await runWith(provider, ceilingIR(100));
    expect(calls.n).toBe(1);
  });

  it('names the ceiling in the trace instead of blaming the JSON', async () => {
    const { provider } = truncatingProvider({ report: true });
    const result = await runWith(provider, ceilingIR(100));
    const gen = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(gen.ok).toBe(false);
    expect(gen.meta.output_ceiling).toMatchObject({
      hit: true, source: 'reported', ceiling: 100, declared: true,
    });
    expect(gen.errors[0].message).toMatch(/Output ceiling reached/);
    expect(gen.errors[0].message).not.toMatch(/No JSON object found/);
  });

  it('catches it via usage when the provider reports nothing', async () => {
    // Custom providers predating the stopReason contract still get a real
    // diagnosis rather than a parse error.
    const { provider } = truncatingProvider({ report: false, completionTokens: 100 });
    const result = await runWith(provider, ceilingIR(100));
    expect(result.failureKind).toBe('output_ceiling');
    const gen = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(gen.meta.output_ceiling.source).toBe('inferred');
  });

  it('reports the default ceiling when the gen declared none', async () => {
    const { provider } = truncatingProvider({ report: true });
    const result = await runWith(provider, ceilingIR(undefined));
    const gen = result.trace.steps.find((s: any) => s.type === 'Generate');
    expect(gen.meta.output_ceiling).toMatchObject({
      ceiling: DEFAULT_MAX_TOKENS, declared: false,
    });
    expect(gen.errors[0].message).toMatch(/no value declared/);
  });

  it('a plain malformed response still fails as validation, not as a ceiling', async () => {
    // Guard against over-firing: unparseable output with a normal stop and
    // usage well under the cap is a genuine parse/validation failure.
    const provider: CambiumProvider = {
      name: 'fakeprov', supportsDocuments: false,
      async generateText() {
        return { text: 'not json at all', stopReason: 'stop' as const,
                 usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } };
      },
      async generateWithTools() { throw new Error('not used'); },
    };
    const result = await runWith(provider, ceilingIR(100));
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('validation');
  });
});
