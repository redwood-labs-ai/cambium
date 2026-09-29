/**
 * #299: the `effort` seam — IR → step handler → runner dispatcher → provider.
 *
 * `effort` compiled, reached every step handler, and was honored by the
 * Anthropic request builder; the runner-level dispatcher between them never
 * forwarded it, so every gen ran at the model's default effort. Coverage
 * existed at both ends (compile-side golden IR, provider-side body builder)
 * and nowhere across the boundary that was actually broken.
 *
 * What is pinned here:
 *   - both dispatchers forward `effort` to the provider (single-shot + agentic)
 *   - an unset `effort` leaves the provider opts and the Anthropic request
 *     body byte-identical (the additive-repair constraint)
 *   - the full path lands `output_config.effort` on the wire
 *
 * Request-body shape assertions (nesting under `output_config`, never sent to
 * sampling-models) live in providers/anthropic.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { makeGenerateText, makeGenerateWithTools } from './runner.js';
import { ProviderRegistry, defineProvider } from './providers/registry.js';
import { anthropicCompatible } from './providers/factories.js';
import { handleGenerate } from './step-handlers.js';
import { runReview } from './compound.js';

const EFFORT_MODEL = 'claude-opus-4-7';

/** Records the opts each dispatch path hands the provider. */
function capturingRegistry() {
  const seen: { text?: any; tools?: any } = {};
  const reg = new ProviderRegistry();
  reg.register(
    defineProvider({
      name: 'cap',
      supportsDocuments: false,
      supportsPromptCacheControl: false,
      async generateText(opts) {
        seen.text = opts;
        return { text: '{"result":"ok"}' };
      },
      async generateWithTools(opts) {
        seen.tools = opts;
        return { message: { content: '{"result":"ok"}', tool_calls: [] } };
      },
    }),
  );
  return { reg, seen };
}

describe('#299 runner dispatcher forwards `effort` to the provider', () => {
  it('generateText: a declared effort reaches provider.generateText', async () => {
    const { reg, seen } = capturingRegistry();
    await makeGenerateText(reg, [])({
      model: 'cap:m',
      system: 'sys',
      prompt: 'p',
      effort: 'max',
    });
    expect(seen.text.effort).toBe('max');
  });

  it('generateWithTools: a declared effort reaches provider.generateWithTools', async () => {
    const { reg, seen } = capturingRegistry();
    await makeGenerateWithTools(reg, [])({
      model: 'cap:m',
      messages: [{ role: 'user', content: 'p' }],
      tools: [],
      effort: 'xhigh',
    });
    expect(seen.tools.effort).toBe('xhigh');
  });

  it('all five levels survive dispatch unchanged', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { reg, seen } = capturingRegistry();
      await makeGenerateText(reg, [])({ model: 'cap:m', system: 's', prompt: 'p', effort: level });
      expect(seen.text.effort).toBe(level);
    }
  });

  it('effort survives a fallback hop (the fallback candidate gets it too)', async () => {
    const calls: any[] = [];
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flaky',
        supportsDocuments: false,
        supportsPromptCacheControl: false,
        async generateText(opts) {
          calls.push({ provider: 'flaky', effort: opts.effort });
          const { ProviderHttpError } = await import('./providers/types.js');
          throw new ProviderHttpError(503, 'unavailable');
        },
        async generateWithTools() {
          throw new Error('unused');
        },
      }),
    );
    reg.register(
      defineProvider({
        name: 'backup',
        supportsDocuments: false,
        supportsPromptCacheControl: false,
        async generateText(opts) {
          calls.push({ provider: 'backup', effort: opts.effort });
          return { text: 'ok' };
        },
        async generateWithTools() {
          throw new Error('unused');
        },
      }),
    );
    await makeGenerateText(reg, [])({
      model: 'flaky:m',
      system: 's',
      prompt: 'p',
      effort: 'high',
      fallbacks: ['backup:m'],
    });
    expect(calls).toEqual([
      { provider: 'flaky', effort: 'high' },
      { provider: 'backup', effort: 'high' },
    ]);
  });

  // The additive-repair constraint: a gen that never declared `effort` must
  // see byte-identical provider opts. `effort: undefined` is the only
  // difference and it must not become a field the provider can observe as set.
  it('an undeclared effort is undefined at the provider, on both paths', async () => {
    const { reg, seen } = capturingRegistry();
    await makeGenerateText(reg, [])({ model: 'cap:m', system: 's', prompt: 'p' });
    await makeGenerateWithTools(reg, [])({
      model: 'cap:m',
      messages: [{ role: 'user', content: 'p' }],
      tools: [],
    });
    expect(seen.text.effort).toBeUndefined();
    expect(seen.tools.effort).toBeUndefined();
  });
});

describe('#299 end to end: ir.effort → output_config.effort on the wire', () => {
  /** Anthropic provider wired to a fetch stub so the real request body is
   *  observable without network. */
  function anthropicCapture() {
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ type: 'text', text: '{"result":"ok"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      } as any;
    }) as any;
    const reg = new ProviderRegistry();
    reg.register(
      anthropicCompatible({
        name: 'anthropic',
        apiKey: () => 'test-key',
        baseUrl: () => 'https://example.invalid',
      } as any),
    );
    return { reg, bodies, restore: () => { globalThis.fetch = realFetch; } };
  }

  const SCHEMA = {
    type: 'object',
    properties: { result: { type: 'string' } },
    required: ['result'],
  };

  it('handleGenerate on an effort-model sends output_config.effort', async () => {
    const { reg, bodies, restore } = anthropicCapture();
    try {
      await handleGenerate(
        { id: 'g', prompt: 'analyze the document' },
        {
          model: { id: `anthropic:${EFFORT_MODEL}`, max_tokens: 400 },
          system: 'inline system prompt',
          effort: 'high',
          context: {},
        } as any,
        SCHEMA,
        makeGenerateText(reg, []),
        (s: string) => JSON.parse(s),
      );
    } finally {
      restore();
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config).toEqual({ effort: 'high' });
  });

  it('the same gen without `effort` sends no output_config (byte-identity)', async () => {
    const { reg, bodies, restore } = anthropicCapture();
    try {
      await handleGenerate(
        { id: 'g', prompt: 'analyze the document' },
        {
          model: { id: `anthropic:${EFFORT_MODEL}`, max_tokens: 400 },
          system: 'inline system prompt',
          context: {},
        } as any,
        SCHEMA,
        makeGenerateText(reg, []),
        (s: string) => JSON.parse(s),
      );
    } finally {
      restore();
    }
    expect(bodies[0].output_config).toBeUndefined();
    expect(bodies[0].effort).toBeUndefined();
  });
});

describe('#299 runReview inherits effort only when it runs on the gen model', () => {
  const IR = (extra: any = {}) => ({
    model: { id: `anthropic:${EFFORT_MODEL}` },
    effort: 'max',
    policies: { grounding: { source: 'doc' } },
    context: { doc: 'the source document' },
    ...extra,
  });

  it('no review model declared → the review runs at the gen effort', async () => {
    let seen: any;
    await runReview(
      { result: 'ok' },
      IR(),
      {},
      (async (opts: any) => { seen = opts; return { text: '{"issues":[]}' }; }) as any,
      (s: string) => JSON.parse(s),
    );
    expect(seen.model).toBe(`anthropic:${EFFORT_MODEL}`);
    expect(seen.effort).toBe('max');
  });

  // RED-176's rule, applied here: a separately-declared model was not chosen
  // with the gen's effort in mind — and on a non-Anthropic review model the
  // field is a silent no-op.
  it('a declared review model does NOT inherit the gen effort', async () => {
    let seen: any;
    await runReview(
      { result: 'ok' },
      IR(),
      {},
      (async (opts: any) => { seen = opts; return { text: '{"issues":[]}' }; }) as any,
      (s: string) => JSON.parse(s),
      undefined,
      { model: 'omlx:qwen' },
    );
    expect(seen.model).toBe('omlx:qwen');
    expect(seen.effort).toBeUndefined();
  });
});
