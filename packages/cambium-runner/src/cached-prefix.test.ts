/**
 * Prompt-cache prefix on the user message — handleGenerate split,
 * runner-level flatten, and the agentic (tools) path.
 *
 *   - handleGenerate (step-handler): does the split fire at the right
 *     boundary, and is the cacheablePrefix byte-stable across a fan-out
 *     (the only invariant that buys an actual Anthropic cache hit)?
 *   - Runner flatten: providers without `supportsPromptCacheControl` see
 *     `<prompt>\n\n<cachedPrefix>` (legacy ordering) and no `cachedPrefix`
 *     field — grounded gens on Ollama/oMLX are unchanged.
 *   - Agentic generateWithTools (#228): the SAME wiring, on purpose — the
 *     tool-call path staying clear of it is what made every agentic turn
 *     re-send its whole prompt uncached. What is guarded now is that the
 *     provider invents no prefix of its own, and that the runner-level
 *     flatten keeps oMLX/Ollama byte-identical (C-3).
 *
 * Builder-shape assertions for buildAnthropicMessagesRequest live in
 * providers/anthropic.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleGenerate, MIN_CACHE_PREFIX_CHARS } from './step-handlers.js';
import { makeGenerateText, makeGenerateWithTools } from './runner.js';
import { ProviderRegistry, defineProvider } from './providers/registry.js';
import { anthropicCompatible } from './providers/factories.js';

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary'],
};

const JSON_TEMPLATE = '{"summary":"","tags":[]}';
const TEMPLATE_LABEL = 'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):';

// Length above MIN_CACHE_PREFIX_CHARS so the split fires. Padded with a
// distinctive marker so assertions can byte-compare without ambiguity.
const LONG_DOC = 'X'.repeat(5000);

function makeIr(overrides: Record<string, any> = {}): any {
  return {
    model: { id: 'omlx:qwen', max_tokens: 800 },
    system: 'You are an analyst.',
    policies: { grounding: { source: 'document' } },
    context: { document: LONG_DOC },
    ...overrides,
  };
}

// Byte-equal reference for handleGenerate's cacheable prefix. Any off-by-one
// in the join order/separator breaks this — and breaks Anthropic cache reuse.
function expectedCacheablePrefix(doc: string, extras: string = ''): string {
  return [
    'DOCUMENT:',
    doc,
    ...(extras ? [extras] : []),
    '',
    TEMPLATE_LABEL,
    JSON_TEMPLATE,
  ].join('\n');
}

describe('handleGenerate cached-prefix split', () => {
  it('grounded + large shared payload: emits the EXACT cacheable prefix as cachedPrefix', async () => {
    let captured: any;
    const fakeGen = async (opts: any) => {
      captured = opts;
      return { text: '{"summary":"ok","tags":[]}' };
    };
    await handleGenerate(
      { id: 'g', prompt: 'Apply the ARCHITECTURE lens.' },
      makeIr(),
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    // Byte-equal: any newline drift or step.prompt leakage defeats the
    // Anthropic byte-identical-prefix cache invariant.
    expect(captured.cachedPrefix).toBe(expectedCacheablePrefix(LONG_DOC));
    expect(captured.prompt).toBe('Apply the ARCHITECTURE lens.');
  });

  it('ungrounded gens stay on the legacy single-string path — byte-identical to pre-split layout', async () => {
    let captured: any;
    const fakeGen = async (opts: any) => {
      captured = opts;
      return { text: '{"summary":"ok","tags":[]}' };
    };
    await handleGenerate(
      { id: 'g', prompt: 'Summarize the document.' },
      makeIr({ policies: {} }), // no grounding
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    expect(captured.cachedPrefix).toBeUndefined();
    // Byte-equal to the pre-split layout — a shifted blank line, a
    // swapped join character, or a reordered section is a silent
    // behavior change for every grounded gen running against a
    // non-Anthropic provider today.
    const expectedLegacy = [
      'Summarize the document.',
      '',
      'DOCUMENT:',
      LONG_DOC,
      '',
      TEMPLATE_LABEL,
      JSON_TEMPLATE,
    ].join('\n');
    expect(captured.prompt).toBe(expectedLegacy);
  });

  it('grounded but below the cache floor: skips the split and preserves legacy ordering', async () => {
    let captured: any;
    const fakeGen = async (opts: any) => {
      captured = opts;
      return { text: '{"summary":"ok","tags":[]}' };
    };
    const tinyDoc = 'two-line doc.';
    await handleGenerate(
      { id: 'g', prompt: 'Summarize.' },
      makeIr({ context: { document: tinyDoc } }),
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    expect(captured.cachedPrefix).toBeUndefined();
    const expectedLegacy = [
      'Summarize.',
      '',
      'DOCUMENT:',
      tinyDoc,
      '',
      TEMPLATE_LABEL,
      JSON_TEMPLATE,
    ].join('\n');
    expect(captured.prompt).toBe(expectedLegacy);
  });

  // Exact-boundary tests: without these, an off-by-one (`>` vs `>=`) in
  // the floor check wouldn't fail any test.
  describe('threshold boundary at MIN_CACHE_PREFIX_CHARS', () => {
    // sharedParts.join('\n') length =
    //   'DOCUMENT:'.length + \n + doc.length + \n
    //   + 0 (blank line) + \n + TEMPLATE_LABEL.length + \n + JSON_TEMPLATE.length
    const overhead =
      'DOCUMENT:'.length + 1 + 1 + 1 + TEMPLATE_LABEL.length + 1 + JSON_TEMPLATE.length;

    it('prefix length exactly at the floor → split fires', async () => {
      const doc = 'd'.repeat(MIN_CACHE_PREFIX_CHARS - overhead);
      // Sanity check the arithmetic — if `overhead` drifts (template label
      // renamed, etc.) the test points at the derivation, not at a
      // misleading false-negative boundary outcome.
      expect(expectedCacheablePrefix(doc).length).toBe(MIN_CACHE_PREFIX_CHARS);

      let captured: any;
      const fakeGen = async (opts: any) => {
        captured = opts;
        return { text: '{"summary":"ok","tags":[]}' };
      };
      await handleGenerate(
        { id: 'g', prompt: 'p' },
        makeIr({ context: { document: doc } }),
        SCHEMA,
        fakeGen as any,
        JSON.parse,
      );
      expect(captured.cachedPrefix).toBe(expectedCacheablePrefix(doc));
    });

    it('prefix length one below the floor → split does NOT fire', async () => {
      const doc = 'd'.repeat(MIN_CACHE_PREFIX_CHARS - overhead - 1);
      expect(expectedCacheablePrefix(doc).length).toBe(MIN_CACHE_PREFIX_CHARS - 1);

      let captured: any;
      const fakeGen = async (opts: any) => {
        captured = opts;
        return { text: '{"summary":"ok","tags":[]}' };
      };
      await handleGenerate(
        { id: 'g', prompt: 'p' },
        makeIr({ context: { document: doc } }),
        SCHEMA,
        fakeGen as any,
        JSON.parse,
      );
      expect(captured.cachedPrefix).toBeUndefined();
    });
  });

  it('fan-out invariant: two gens with the same grounding emit byte-identical cachedPrefix', async () => {
    const captured: any[] = [];
    const fakeGen = async (opts: any) => {
      captured.push(opts);
      return { text: '{"summary":"ok","tags":[]}' };
    };
    const ir = makeIr();
    await handleGenerate(
      { id: 'a', prompt: 'Lens A.' },
      ir,
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    await handleGenerate(
      { id: 'b', prompt: 'Lens B.' },
      ir,
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    expect(captured[0].cachedPrefix).toBeDefined();
    // Byte-identical prefix → cache hit on branch 2..N. The whole feature
    // is worthless without this.
    expect(captured[0].cachedPrefix).toBe(captured[1].cachedPrefix);
    expect(captured[0].prompt).toBe('Lens A.');
    expect(captured[1].prompt).toBe('Lens B.');
  });

  it('multi-gen fan-out: distinct IRs sharing grounding + context + schema produce byte-identical cachedPrefix', async () => {
    // Real fan-out posture: each reviewer gen is a separate `.cmb.rb` file
    // that compiles to its own IR. The prefix construction reads only
    // `ir.policies.grounding`, `ir.context`, and the schema arg — fields
    // that DO vary across reviewer gens (system, model.id, model.temperature,
    // ir.id, etc.) MUST NOT bleed into the prefix, or the cache key diverges
    // and the fan-out cache hit rate drops to zero.
    const captured: any[] = [];
    const fakeGen = async (opts: any) => {
      captured.push(opts);
      return { text: '{"summary":"ok","tags":[]}' };
    };
    // Two independently-constructed IRs sharing only the cache-relevant
    // surface; everything else deliberately differs.
    const sharedContext = { document: LONG_DOC, diff_surface: 'ruby_dsl, runner' };
    const sharedGrounding = { policies: { grounding: { source: 'document' } } };
    const irArchitecture = {
      ...sharedGrounding,
      id: 'architecture_reviewer',
      system: 'You are an architecture reviewer.',
      model: { id: 'anthropic:claude-opus-4-7', max_tokens: 1200, temperature: 0.1 },
      context: sharedContext,
    };
    const irSecurity = {
      ...sharedGrounding,
      id: 'security_reviewer',
      system: 'You are a security reviewer focused on auth, input validation, secret handling.',
      model: { id: 'anthropic:claude-sonnet-4-6', max_tokens: 800, temperature: 0.2 },
      context: sharedContext,
    };
    await handleGenerate(
      { id: 'arch', prompt: 'Apply the ARCHITECTURE lens.' },
      irArchitecture,
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    await handleGenerate(
      { id: 'sec', prompt: 'Apply the SECURITY lens.' },
      irSecurity,
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    // Two distinct IRs, two distinct systems, two distinct models — but the
    // cacheablePrefix must be byte-identical because the cache-relevant
    // surface (grounding source + context + schema) matches.
    expect(captured[0].cachedPrefix).toBeDefined();
    expect(captured[0].cachedPrefix).toBe(captured[1].cachedPrefix);
    expect(captured[0].prompt).toBe('Apply the ARCHITECTURE lens.');
    expect(captured[1].prompt).toBe('Apply the SECURITY lens.');
  });

  it('cached-prefix path includes pipeline bind() context sections inside the prefix', async () => {
    let captured: any;
    const fakeGen = async (opts: any) => {
      captured = opts;
      return { text: '{"summary":"ok","tags":[]}' };
    };
    await handleGenerate(
      { id: 'g', prompt: 'Lens A.' },
      makeIr({
        context: {
          document: LONG_DOC,
          diff_surface: 'ruby_dsl, runner', // RED-382 non-primary context
        },
      }),
      SCHEMA,
      fakeGen as any,
      JSON.parse,
    );
    // bind() context lands inside the cacheable prefix between doc and
    // template — not in the per-call instruction. (Guards RED-382 against
    // a regression where the split logic drops or misplaces these.)
    const expectedPrefix = expectedCacheablePrefix(
      LONG_DOC,
      ['', 'DIFF_SURFACE:', 'ruby_dsl, runner'].join('\n'),
    );
    expect(captured.cachedPrefix).toBe(expectedPrefix);
    expect(captured.prompt).toBe('Lens A.');
  });
});

describe('runner-level flatten for providers without prompt-cache support', () => {
  it('cache-aware provider receives cachedPrefix unchanged + original prompt', async () => {
    let seen: any;
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'cached',
        supportsDocuments: false,
        supportsPromptCacheControl: true,
        async generateText(opts) {
          seen = opts;
          return { text: 'ok' };
        },
        async generateWithTools() {
          throw new Error('not used');
        },
      }),
    );
    const gen = makeGenerateText(reg, []);
    await gen({
      model: 'cached:m',
      system: 'sys',
      prompt: 'per-call instruction',
      cachedPrefix: 'SHARED_PREFIX_PAYLOAD',
    });
    // Split survives dispatch — provider can emit a real cache breakpoint.
    expect(seen.prompt).toBe('per-call instruction');
    expect(seen.cachedPrefix).toBe('SHARED_PREFIX_PAYLOAD');
  });

  it('cache-unaware provider sees `<prompt>\\n\\n<cachedPrefix>` and no cachedPrefix field', async () => {
    let seen: any;
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flat',
        supportsDocuments: false,
        // No supportsPromptCacheControl — runner MUST flatten.
        async generateText(opts) {
          seen = opts;
          return { text: 'ok' };
        },
        async generateWithTools() {
          throw new Error('not used');
        },
      }),
    );
    const gen = makeGenerateText(reg, []);
    await gen({
      model: 'flat:m',
      system: 'sys',
      prompt: 'per-call instruction',
      cachedPrefix: 'SHARED_PREFIX_PAYLOAD',
    });
    expect(seen.cachedPrefix).toBeUndefined();
    // Legacy ordering (instruction first, then shared payload). Reversing
    // would silently change behavior for every grounded gen running
    // against a non-Anthropic provider.
    expect(seen.prompt).toBe('per-call instruction\n\nSHARED_PREFIX_PAYLOAD');
  });

  it('cache-unaware provider with no cachedPrefix: prompt passes through identical', async () => {
    let seen: any;
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flat',
        supportsDocuments: false,
        async generateText(opts) {
          seen = opts;
          return { text: 'ok' };
        },
        async generateWithTools() {
          throw new Error('not used');
        },
      }),
    );
    const gen = makeGenerateText(reg, []);
    await gen({
      model: 'flat:m',
      system: 'sys',
      prompt: 'just the prompt',
    });
    expect(seen.prompt).toBe('just the prompt');
    expect(seen.cachedPrefix).toBeUndefined();
  });
});

describe('--mock fidelity with cachedPrefix (AUD-001)', () => {
  // The mock short-circuit at runner.ts:makeGenerateText must reconstruct the
  // full flattened prompt (the way a non-cache provider sees it) so golden
  // tests based on --mock produce the same output for grounded ≥4 KB gens
  // as they did before the cached-prefix split was introduced.
  afterEach(() => vi.unstubAllEnvs());

  it('mock sees prompt + cachedPrefix flattened (metric in prefix is visible)', async () => {
    vi.stubEnv('CAMBIUM_ALLOW_MOCK', '1');
    // No provider registered — mock fires before provider lookup.
    const reg = new ProviderRegistry();
    const gen = makeGenerateText(reg, []);
    // Latency metric lives only in the cachedPrefix, not in the per-call
    // instruction. Pre-fix: mockGenerate received only opts.prompt →
    // latency_ms_samples: []. Post-fix: full flattened prompt →
    // latency_ms_samples: [100].
    const result = await gen({
      model: 'flat:m',
      system: 'sys',
      prompt: 'Apply the ARCHITECTURE lens.',
      cachedPrefix: 'DOCUMENT:\nThe system processed the request in 100ms total.',
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.metrics.latency_ms_samples).toEqual([100]);
  });

  it('mock without cachedPrefix is byte-identical to pre-split behavior', async () => {
    vi.stubEnv('CAMBIUM_ALLOW_MOCK', '1');
    const reg = new ProviderRegistry();
    const gen = makeGenerateText(reg, []);
    const result = await gen({
      model: 'flat:m',
      system: 'sys',
      prompt: 'Apply the ARCHITECTURE lens.',
    });
    const parsed = JSON.parse(result.text);
    // No ms patterns anywhere → latency_ms_samples stays empty.
    expect(parsed.metrics.latency_ms_samples).toEqual([]);
  });
});

describe('agentic generateWithTools and the cachedPrefix wiring (#228)', () => {
  // This block used to assert the OPPOSITE: that the tools path
  // deliberately stayed clear of the cachedPrefix plumbing, on the theory
  // that "multi-turn caching has different semantics". #228 is the bug
  // that theory produced — the agentic loop re-sent its whole prompt
  // uncached on every turn. The wiring is now shared on purpose, and what
  // needs guarding is the opposite direction: the provider must not invent
  // a prefix marker for a caller that did not ask for one.

  type Captured = { url: string; init: RequestInit };
  function stubFetch(response: any): () => Captured {
    let captured: Captured | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as any;
    });
    return () => captured!;
  }
  afterEach(() => vi.unstubAllGlobals());

  function anthropic() {
    return anthropicCompatible({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: () => 'k',
    });
  }

  it('a long user message with NO cachedPrefix is still a plain string — the provider invents nothing', async () => {
    const get = stubFetch({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // 10000-char user message — well above any cache floor. The eligibility
    // decision belongs to the dispatch site (buildCacheablePrefix), not to
    // the provider; a provider that started splitting on its own would move
    // the cache key for every caller.
    const hugeUserText = 'U'.repeat(10000);
    await anthropic().generateWithTools({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'you are a helpful assistant' },
        { role: 'user', content: hugeUserText },
      ],
      tools: [],
    });
    const body = JSON.parse(get().init.body as string);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe(hugeUserText);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('a cachedPrefix handed to the tools path DOES reach the request as a marked block', async () => {
    const get = stubFetch({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const prefix = `DOCUMENT:\n${'P'.repeat(6000)}`;
    await anthropic().generateWithTools({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
      ],
      tools: [],
      cachedPrefix: prefix,
    });
    const body = JSON.parse(get().init.body as string);
    expect(body.messages[0].content[0]).toEqual({
      type: 'text',
      text: prefix,
      cache_control: { type: 'ephemeral' },
    });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'Investigate.' });
    // The automatic breakpoint — tools path only.
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('C-3: the agentic cachedPrefix wiring is invisible to oMLX/Ollama', () => {
  // `supportsPromptCacheControl` is false for `openaiCompatible`, so the
  // runner folds the prefix back into the first user message before
  // dispatch. The provider must see ONE string in the legacy
  // `<prompt>\n\n<prefix>` order and no `cachedPrefix` field — byte-for-byte
  // what it saw before the agentic split existed.

  const LONG_PREFIX = `DOCUMENT:\n${'P'.repeat(6000)}`;

  function flatProvider(seen: any[]) {
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flat',
        supportsDocuments: false,
        // No supportsPromptCacheControl — oMLX and Ollama both land here.
        async generateText() {
          throw new Error('not used');
        },
        async generateWithTools(opts) {
          seen.push(JSON.parse(JSON.stringify(opts)));
          return { message: { content: 'ok', tool_calls: [] } };
        },
      }),
    );
    return reg;
  }

  it('folds the prefix into the FIRST user message and strips the field', async () => {
    const seen: any[] = [];
    const gen = makeGenerateWithTools(flatProvider(seen), []);
    await gen({
      model: 'flat:m',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
      ],
      tools: [],
      cachedPrefix: LONG_PREFIX,
    });
    expect(seen[0].cachedPrefix).toBeUndefined();
    expect(seen[0].messages[0]).toEqual({ role: 'system', content: 'sys' });
    // Legacy ordering: instruction first, shared payload second. Reversing
    // it would silently change what every oMLX/Ollama agentic gen sees.
    expect(seen[0].messages[1]).toEqual({
      role: 'user',
      content: `Investigate.\n\n${LONG_PREFIX}`,
    });
  });

  it('folds into the first user message even mid-transcript, never into a tool result', async () => {
    const seen: any[] = [];
    const gen = makeGenerateWithTools(flatProvider(seen), []);
    await gen({
      model: 'flat:m',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 't1' },
      ],
      tools: [],
      cachedPrefix: LONG_PREFIX,
    });
    expect(seen[0].messages[1].content).toBe(`Investigate.\n\n${LONG_PREFIX}`);
    // Later turns untouched.
    expect(seen[0].messages[3]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 't1',
    });
  });

  it('does not mutate the caller\'s messages array — the loop reuses it across turns', async () => {
    const seen: any[] = [];
    const gen = makeGenerateWithTools(flatProvider(seen), []);
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Investigate.' },
    ];
    await gen({ model: 'flat:m', messages, tools: [], cachedPrefix: LONG_PREFIX });
    await gen({ model: 'flat:m', messages, tools: [], cachedPrefix: LONG_PREFIX });
    // If the fold wrote through, turn 2 would carry the prefix TWICE.
    expect(messages[1].content).toBe('Investigate.');
    expect(seen[0].messages[1].content).toBe(seen[1].messages[1].content);
  });

  it('no cachedPrefix: messages pass through as the very same array', async () => {
    const seen: any[] = [];
    const gen = makeGenerateWithTools(flatProvider(seen), []);
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Investigate.' },
    ];
    await gen({ model: 'flat:m', messages, tools: [] });
    expect(seen[0].cachedPrefix).toBeUndefined();
    expect(seen[0].messages).toEqual(messages);
  });

  it('a cache-aware provider on the tools path receives the split unchanged', async () => {
    const seen: any[] = [];
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'cached',
        supportsDocuments: false,
        supportsPromptCacheControl: true,
        async generateText() {
          throw new Error('not used');
        },
        async generateWithTools(opts) {
          seen.push(JSON.parse(JSON.stringify(opts)));
          return { message: { content: 'ok', tool_calls: [] } };
        },
      }),
    );
    const gen = makeGenerateWithTools(reg, []);
    await gen({
      model: 'cached:m',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
      ],
      tools: [],
      cachedPrefix: LONG_PREFIX,
    });
    expect(seen[0].cachedPrefix).toBe(LONG_PREFIX);
    expect(seen[0].messages[1].content).toBe('Investigate.');
  });
});
