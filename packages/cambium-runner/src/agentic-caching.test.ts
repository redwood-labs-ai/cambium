/**
 * #228: prompt caching on the agentic (multi-turn tool-use) path.
 *
 * These started life (STEP-001) as CHARACTERIZATION tests pinning the bug:
 * every turn carried exactly 2 breakpoints — `system[0]` and `tools[last]`,
 * ZERO inside the messages array — so the whole transcript, including the
 * shared document, was re-billed uncached on every turn and cost was
 * quadratic in turn count. Measured then, on an ungrounded agentic gen with
 * a 6 KB document and 8 tool turns:
 *
 *   turn | explicit breakpoints | uncached messages bytes
 *   -----+----------------------+------------------------
 *      1 | 2                    |  6,102
 *      4 | 2                    | 10,368
 *      8 | 2                    | 16,056
 *
 * STEP-007 flipped them to the fixed expectations (same fixture, same
 * numbers to compare against):
 *
 *   turn | explicit | automatic | bytes after the last EXPLICIT breakpoint
 *   -----+----------+-----------+-----------------------------------------
 *      1 | 3        | 1         |      2
 *      4 | 3        | 1         |  4,237
 *      8 | 3        | 1         |  9,885
 *
 * The measurement technique is the one that proved the bug: drive the real
 * `handleAgenticGenerate` loop, capture each turn's `generateWithTools`
 * opts, and build the real Anthropic request body through
 * `buildAnthropicMessagesRequest` — exactly as `anthropicCompatible`'s
 * `generateWithTools` does in `providers/factories.ts`. No API key, no
 * network: the request body IS the observable (C-5).
 *
 * LIMIT OF THIS EVIDENCE. The fourth breakpoint is Anthropic's AUTOMATIC
 * one: a top-level `cache_control` field the server applies to the last
 * cacheable block and advances as the transcript grows. Its position is
 * chosen server-side, so nothing here can assert where it lands — only
 * that it is requested. "Bytes after the last EXPLICIT breakpoint" above is
 * therefore the region the automatic breakpoint is responsible for, not a
 * region proven uncached. Live cache-hit measurement is a separate ticket
 * (deliberately out of scope, user decision 2026-09-05).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { handleAgenticGenerate, handleGenerate, buildCacheablePrefix } from './step-handlers.js';
import { buildAnthropicMessagesRequest } from './providers/anthropic.js';
import { makeGenerateWithTools, makeGenerateText } from './runner.js';
import { ProviderRegistry, defineProvider } from './providers/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { testOverrideHandlers } from './tools/index.js';

const BUILTINS = join(process.cwd(), 'packages/cambium-runner/src/builtin-tools');

const registry = new ToolRegistry();
await registry.loadFromDir(BUILTINS);

// Pure shim, same pattern as agentic-duplicate-toolcall.test.ts: def on the
// registry, handler in testOverrideHandlers. Returns a chunky payload so the
// transcript actually grows turn over turn (that growth is the cost being
// measured).
(registry as any).defs.set('probe', {
  name: 'probe',
  description: 'probe tool',
  permissions: { pure: true },
  inputSchema: {},
  outputSchema: {},
});
testOverrideHandlers['probe'] = async (input: any) => ({
  q: input.q,
  findings: 'F'.repeat(1200),
});

const SCHEMA = {
  type: 'object',
  required: ['answer'],
  properties: {
    answer: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

// Deliberately UNGROUNDED — every agentic gen in the tree is (DEC-002).
// A grounded fixture would prove nothing about the reported shape.
// 6000 chars clears MIN_CACHE_PREFIX_CHARS (4096) with margin.
const LONG_DOC = 'The subsystem under review. '.repeat(215);

function makeIr(): any {
  return {
    mode: 'agentic',
    model: { id: 'anthropic:claude-sonnet-4-6', max_tokens: 900, temperature: 0.2 },
    system: 'You are a research agent.',
    context: { document: LONG_DOC },
    policies: {},
  };
}

// ── Breakpoint accounting ─────────────────────────────────────────────

type Breakpoints = {
  /** `cache_control` markers on the top-level `system` blocks. */
  system: number;
  /** `cache_control` markers on tool definitions. */
  tools: number;
  /** `cache_control` markers anywhere inside the `messages` array. */
  messages: number;
  /** The automatic breakpoint: `cache_control` as a sibling of `model`. */
  automatic: number;
  /** system + tools + messages. Anthropic's ceiling for EXPLICIT
   *  block-level markers is 4 total, and the automatic breakpoint consumes
   *  one of those slots — so 3 is the real ceiling once it is in play. */
  explicit: number;
};

function countMarkers(node: any): number {
  if (Array.isArray(node)) return node.reduce((n, v) => n + countMarkers(v), 0);
  if (node && typeof node === 'object') {
    let n = node.cache_control ? 1 : 0;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control') continue;
      n += countMarkers(v);
    }
    return n;
  }
  return 0;
}

function breakpointsOf(body: any): Breakpoints {
  const system = countMarkers(body.system);
  const tools = countMarkers(body.tools);
  const messages = countMarkers(body.messages);
  return {
    system,
    tools,
    messages,
    automatic: body.cache_control ? 1 : 0,
    explicit: system + tools + messages,
  };
}

/** Bytes of the messages array that no cache region can cover: everything
 *  after the last message carrying a breakpoint. With zero message-level
 *  breakpoints this is the entire transcript, re-billed every turn. */
function uncachedMessagesBytes(body: any): number {
  const msgs: any[] = body.messages;
  let lastMarked = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (countMarkers(msgs[i]) > 0) lastMarked = i;
  }
  return JSON.stringify(msgs.slice(lastMarked + 1)).length;
}

// ── Harness ───────────────────────────────────────────────────────────

/** Run the real agentic loop for `toolTurns` tool-calling turns followed by
 *  a final JSON turn, capturing the Anthropic request body of every turn.
 *  The body is built inside the fake provider because `messages` is one
 *  array mutated in place across turns — snapshotting after the fact would
 *  measure the final transcript N times. */
async function captureTurnBodies(toolTurns: number): Promise<any[]> {
  const bodies: any[] = [];
  let turn = 0;

  const generateWithTools = async (opts: any) => {
    turn++;
    bodies.push(
      buildAnthropicMessagesRequest({
        model: 'claude-sonnet-4-6',
        messages: opts.messages,
        tools: opts.tools,
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
        effort: opts.effort,
        documents: opts.documents ?? [],
        cacheUserPrefix: opts.cachedPrefix,
      }),
    );
    if (turn <= toolTurns) {
      return {
        message: {
          content: null,
          tool_calls: [{
            id: `c${turn}`,
            // `as const` keeps the literal type — GenerateWithToolsFn wants
            // 'function', not string.
            type: 'function' as const,
            function: { name: 'probe', arguments: `{"q":"query ${turn}"}` },
          }],
        },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    return {
      message: { content: '{"answer":"done","notes":[]}', tool_calls: undefined },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  };

  const result = await handleAgenticGenerate(
    { id: 'gen_probe', prompt: 'Investigate the subsystem and report.' },
    makeIr(),
    SCHEMA,
    registry.toOpenAIFormat(['probe']),
    registry,
    ['probe'],
    generateWithTools,
    (t: string) => JSON.parse(t),
    /* maxToolCalls */ 20,
    {},
  );
  // Sanity: the loop must have actually completed, or the bodies are junk.
  expect(result.parsed).toEqual({ answer: 'done', notes: [] });
  return bodies;
}

// ── Fixed behavior (was: characterization) ────────────────────────────

describe('#228 — agentic turns carry the cacheable prefix and the automatic breakpoint', () => {
  it('turn 1, 4 and 8 each carry 3 explicit breakpoints + the automatic one = Anthropic\'s four', async () => {
    const bodies = await captureTurnBodies(8);
    for (const turn of [1, 4, 8]) {
      const bp = breakpointsOf(bodies[turn - 1]);
      expect({ turn, ...bp }).toEqual({
        turn,
        system: 1,
        tools: 1,
        // The user-prompt prefix block, inside the first user message.
        messages: 1,
        automatic: 1,
        explicit: 3,
      });
    }
  });

  it('every turn stays at exactly 3 explicit + 1 automatic — a 4th explicit marker is an HTTP 400', async () => {
    const bodies = await captureTurnBodies(8);
    for (const body of bodies) {
      const bp = breakpointsOf(body);
      expect(bp.explicit).toBe(3);
      expect(bp.explicit + bp.automatic).toBe(4);
    }
  });

  it('the marker inside the messages array sits on the shared prefix block, first user message', async () => {
    const bodies = await captureTurnBodies(8);
    for (const body of bodies) {
      const first = body.messages[0];
      expect(first.role).toBe('user');
      // [ prefix (marked) , step.prompt (unmarked, varies per call) ]
      expect(first.content).toHaveLength(2);
      expect(first.content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(first.content[0].text).toContain(LONG_DOC);
      expect(first.content[1]).toEqual({
        type: 'text',
        text: 'Investigate the subsystem and report.',
      });
      // Nothing else in the transcript carries an explicit marker — the
      // automatic breakpoint covers the growing tail.
      expect(countMarkers(body.messages.slice(1))).toBe(0);
    }
  });

  it('the cached prefix block is byte-identical across all turns — the cache-hit precondition', async () => {
    const bodies = await captureTurnBodies(8);
    const blocks = bodies.map((b) => JSON.stringify(b.messages[0].content[0]));
    // One byte of drift between turns and every turn is a cache write.
    expect(new Set(blocks).size).toBe(1);
  });

  it('the shared document leaves the uncached tail entirely (was 6,102 bytes on turn 1)', async () => {
    const bodies = await captureTurnBodies(8);
    const bytes = bodies.map(uncachedMessagesBytes);
    // Turn 1: the whole first user message is inside the prefix marker's
    // region, so what follows it is the empty array — `[]`, two bytes.
    expect(bytes[0]).toBe(2);
    // The document never appears after the last explicit breakpoint again.
    for (const body of bodies) {
      const msgs: any[] = body.messages;
      let lastMarked = -1;
      for (let i = 0; i < msgs.length; i++) if (countMarkers(msgs[i]) > 0) lastMarked = i;
      expect(JSON.stringify(msgs.slice(lastMarked + 1))).not.toContain(LONG_DOC);
    }
    // What still grows is the transcript itself — that is precisely the
    // region the automatic breakpoint takes over (see the header note).
    expect(bytes[7]).toBeGreaterThan(bytes[0]);
  });
});

// ── --mock fidelity ───────────────────────────────────────────────────

describe('#228 — --mock still sees the document the split moved into cachedPrefix', () => {
  // Same posture as the generateText mock (AUD-001). Without this, every
  // golden test over an agentic gen with a >4 KB context would start
  // generating from `step.prompt` alone — the document silently gone.
  afterEach(() => vi.unstubAllEnvs());

  it('reconstructs `<prompt>\\n\\n<prefix>` before deriving the mock output', async () => {
    vi.stubEnv('CAMBIUM_ALLOW_MOCK', '1');
    // No provider registered — the mock fires before provider lookup.
    const gen = makeGenerateWithTools(new ProviderRegistry(), []);
    const result = await gen({
      model: 'flat:m',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
      ],
      tools: [],
      // The latency metric lives only in the prefix. Pre-fix the mock saw
      // the user message alone and produced an empty sample list.
      cachedPrefix: 'DOCUMENT:\nThe system processed the request in 100ms total.',
    });
    const parsed = JSON.parse(result.message.content!);
    expect(parsed.metrics.latency_ms_samples).toEqual([100]);
  });

  it('no cachedPrefix: mock behavior is unchanged', async () => {
    vi.stubEnv('CAMBIUM_ALLOW_MOCK', '1');
    const gen = makeGenerateWithTools(new ProviderRegistry(), []);
    const result = await gen({
      model: 'flat:m',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Investigate.' },
      ],
      tools: [],
    });
    const parsed = JSON.parse(result.message.content!);
    expect(parsed.metrics.latency_ms_samples).toEqual([]);
  });
});

// ── DEC-008: the agentic user prompt's CONTENT does not change ────────

describe('#228 DEC-008 — an oMLX/Ollama agentic dispatch is byte-identical to pre-#228', () => {
  // #228 is a cost bug and adds no prompt CONTENT. Routing the agentic
  // user message through the shared `buildCacheablePrefix` would otherwise
  // have appended an OUTPUT_JSON_TEMPLATE block the hand-rolled version
  // never emitted — on every provider, not just Anthropic.
  // `includeOutputTemplate: false` suppresses it.
  //
  // SCOPE OF THIS BLOCK (AUD-002). These assertions cover providers WITHOUT
  // `supportsPromptCacheControl`, where the prompt is byte-identical to
  // pre-#228. They do NOT — and cannot — speak for Anthropic above the
  // cache floor, where the same text is deliberately laid out differently:
  // the instruction moves after the prefix and the `\n\n` separator is
  // dropped, because the cached region extends backward from the marker.
  // Measured: 6,069 -> 6,067 chars, the two newlines. That is the layout
  // the single-shot path has used since 0.8.1; the Anthropic block
  // structure is asserted separately, above.
  //
  // This is a FROZEN reproduction of main@77c7ec2's assembly, not a
  // re-derivation: the expected string below is the pre-#228 recipe
  // (`[step.prompt, '', 'DOCUMENT:', doc]` + RED-382 context sections)
  // written out by hand. A differential against the real pre-#228 handler
  // was run once at build time over three IR shapes (long/ungrounded,
  // long/grounded, short/ungrounded) and reported the WHOLE dispatch —
  // every turn, every field — byte-identical; this is its permanent form.

  /** A provider with no `supportsPromptCacheControl` — oMLX and Ollama
   *  both land here. Captures what actually crosses the boundary. */
  function flatRegistry(seen: any[]): ProviderRegistry {
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flat',
        supportsDocuments: false,
        async generateText() {
          throw new Error('not used');
        },
        async generateWithTools(opts) {
          seen.push(JSON.parse(JSON.stringify(opts)));
          return { message: { content: '{"answer":"done","notes":[]}' } };
        },
      }),
    );
    return reg;
  }

  async function dispatchOnce(doc: string, extraContext: Record<string, any> = {}) {
    const seen: any[] = [];
    await handleAgenticGenerate(
      { id: 'g', prompt: 'Investigate the subsystem and report.' },
      {
        mode: 'agentic',
        model: { id: 'flat:m', max_tokens: 900, temperature: 0.2 },
        system: 'You are a research agent.',
        context: { document: doc, ...extraContext },
        policies: {},
      },
      SCHEMA,
      registry.toOpenAIFormat(['probe']),
      registry,
      ['probe'],
      makeGenerateWithTools(flatRegistry(seen), []),
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 20,
      {},
    );
    return seen[0];
  }

  /** main@77c7ec2's `contextParts` recipe, verbatim. No template. */
  function legacyUserMessage(doc: string, sections: string[] = []): string {
    return [
      'Investigate the subsystem and report.',
      '',
      'DOCUMENT:',
      doc,
      ...sections,
    ].join('\n');
  }

  it('above the cache floor: the first user message is the exact pre-#228 string', async () => {
    const opts = await dispatchOnce(LONG_DOC, { extra_note: 'a bind() section' });
    expect(opts.cachedPrefix).toBeUndefined();
    expect(opts.messages[1].content).toBe(
      legacyUserMessage(LONG_DOC, ['', 'EXTRA_NOTE:', 'a bind() section']),
    );
    // The template block is what DEC-008 suppresses — assert its absence
    // directly so a default flip is unmissable.
    expect(opts.messages[1].content).not.toContain('OUTPUT_JSON_TEMPLATE');
  });

  it('below the cache floor: unchanged too (the legacy single-string branch)', async () => {
    const shortDoc = 'a tiny doc';
    const opts = await dispatchOnce(shortDoc);
    expect(opts.cachedPrefix).toBeUndefined();
    expect(opts.messages[1].content).toBe(legacyUserMessage(shortDoc));
  });

  it('the single-shot path KEEPS the template — the flag defaults to today\'s behavior', () => {
    const ir = {
      model: { id: 'anthropic:m' },
      context: { document: LONG_DOC },
      policies: { grounding: { source: 'document' } },
    };
    const docInput = { documents: [], groundingTextByKey: {} };
    // No opts, and `{}` — both must behave as before.
    for (const opts of [undefined, {}, { requireGrounding: false }]) {
      const { cacheablePrefix } = buildCacheablePrefix(ir, SCHEMA, docInput, opts as any);
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
      );
      expect(cacheablePrefix.endsWith('{"answer":"","notes":[]}')).toBe(true);
    }
    // Only the explicit opt-out drops it.
    const suppressed = buildCacheablePrefix(ir, SCHEMA, docInput, {
      includeOutputTemplate: false,
    }).cacheablePrefix;
    expect(suppressed).not.toContain('OUTPUT_JSON_TEMPLATE');
    // ...and drops NOTHING else.
    expect(
      `${suppressed}\n\nOUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):\n{"answer":"","notes":[]}`,
    ).toBe(buildCacheablePrefix(ir, SCHEMA, docInput).cacheablePrefix);
  });
});

// ── AUD-005: a missing `step.prompt` must not become the text "null" ──

describe('#228 AUD-005 — absent step.prompt coerces to empty, not to "null"', () => {
  // `main` built the legacy prompt with
  // `[step.prompt, '', 'DOCUMENT:', doc].join('\n')`, and Array.join coerces
  // null/undefined to ''. #228 replaced both sites with template literals,
  // which stringify them instead — putting the literal text "null" on the
  // first line. Reachable from `generate(nil)` and from a hand-built or
  // precompiled .ir.json (#195) whose Generate step omits `prompt`.
  const SHORT_DOC = 'a tiny doc';   // below the cache floor -> legacy branch

  function irFor(doc: string) {
    return {
      model: { id: 'flat:m', max_tokens: 900, temperature: 0.2 },
      system: 'You are an analyst.',
      context: { document: doc },
      policies: {},
    };
  }

  for (const [label, prompt] of [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ] as Array<[string, any]>) {
    it(`single-shot path, prompt = ${label}: no stringified placeholder`, async () => {
      let seen: any;
      await handleGenerate(
        { id: 'g', prompt },
        irFor(SHORT_DOC),
        SCHEMA,
        (async (opts: any) => {
          seen = opts;
          return { text: '{"answer":"ok","notes":[]}' };
        }) as any,
        (t: string) => JSON.parse(t),
        { documents: [], groundingTextByKey: {} },
      );
      // The single-shot prefix keeps its OUTPUT_JSON_TEMPLATE tail
      // (DEC-008 only suppresses it for agentic), so build the expected
      // prefix through the assembler and assert the JOIN — the coercion is
      // what this test is about.
      const { cacheablePrefix } = buildCacheablePrefix(
        irFor(SHORT_DOC),
        SCHEMA,
        { documents: [], groundingTextByKey: {} },
      );
      expect(seen.prompt).toBe(`\n\n${cacheablePrefix}`);
      expect(seen.prompt.startsWith('\n\nDOCUMENT:')).toBe(true);
      expect(seen.prompt).not.toContain('null');
      expect(seen.prompt).not.toContain('undefined');
    });

    it(`agentic path, prompt = ${label}: no stringified placeholder`, async () => {
      let seen: any;
      await handleAgenticGenerate(
        { id: 'g', prompt },
        { ...irFor(SHORT_DOC), mode: 'agentic' },
        SCHEMA,
        [],
        {} as any,
        [],
        (async (opts: any) => {
          seen = opts;
          return { message: { content: '{"answer":"ok","notes":[]}' } };
        }) as any,
        (t: string) => JSON.parse(t),
        /* maxToolCalls */ 3,
        {},
      );
      const user = seen.messages[1].content;
      expect(user).toBe(`\n\nDOCUMENT:\n${SHORT_DOC}`);
      expect(user).not.toContain('null');
      expect(user).not.toContain('undefined');
    });
  }

  // AUD-R2-001/003: the CACHED branch. `legacyPrompt` is only read when
  // `useCachedPrefix === false`, so the round-1 fix could not reach a
  // grounded gen above the cache floor — the handler passed `step.prompt`
  // through raw and the coercion happened two frames downstream in
  // `runner.ts`. Net effect as shipped: the same gen's prompt depended on
  // document size. These two cases cover that branch on both handlers.

  it('agentic, above the cache floor: the instruction tail is "" — not null, not "null"', async () => {
    let seen: any;
    await handleAgenticGenerate(
      { id: 'g', prompt: null },
      { ...irFor(LONG_DOC), mode: 'agentic' },
      SCHEMA,
      [],
      {} as any,
      [],
      (async (opts: any) => {
        seen = opts;
        return { message: { content: '{"answer":"ok","notes":[]}' } };
      }) as any,
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 3,
      {},
    );
    expect(seen.cachedPrefix).toContain(LONG_DOC);
    // No `?? ''` here — laundering the value through the same operator the
    // handler is supposed to apply is how the round-1 version of this test
    // passed against un-fixed code.
    expect(seen.messages[1].content).toBe('');
  });

  it('single-shot, grounded, above the cache floor: the provider receives no "null" (AUD-R2-001)', async () => {
    // Asserts the string that actually crosses the provider boundary, via
    // the real `makeGenerateText` — a provider without
    // `supportsPromptCacheControl`, so the runner folds prefix into prompt
    // at `runner.ts`, which is exactly where the round-1 fix did not reach.
    let seen: any;
    const reg = new ProviderRegistry();
    reg.register(
      defineProvider({
        name: 'flat',
        supportsDocuments: false,
        async generateText(opts) {
          seen = opts;
          return { text: '{"answer":"ok","notes":[]}' };
        },
        async generateWithTools() {
          throw new Error('not used');
        },
      }),
    );
    // Grounded so `useCachedPrefix` fires — this is the exact population
    // the cached branch exists for.
    const ir = {
      model: { id: 'flat:m', max_tokens: 900 },
      system: 'You are an analyst.',
      context: { document: LONG_DOC },
      policies: { grounding: { source: 'document' } },
    };
    await handleGenerate(
      { id: 'g', prompt: null },
      ir,
      SCHEMA,
      makeGenerateText(reg, []) as any,
      (t: string) => JSON.parse(t),
      { documents: [], groundingTextByKey: {} },
    );
    const { cacheablePrefix } = buildCacheablePrefix(ir, SCHEMA, {
      documents: [],
      groundingTextByKey: {},
    });
    expect(seen.prompt).toBe(`\n\n${cacheablePrefix}`);
    expect(seen.prompt.startsWith('null')).toBe(false);
    expect(seen.prompt).not.toContain('null');
  });
});
