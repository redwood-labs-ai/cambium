/**
 * #182 — `exclude_from_prefix`: context keys that reach the model but not
 * the cacheable prefix.
 *
 * Three things are load-bearing here, in order of blast radius:
 *
 *   1. **Byte-identity for every gen that doesn't declare it.** The prefix
 *      is addressed by a content hash, so a single stray byte invalidates
 *      every warm entry a deployed consumer holds. `excludeFromPrefix`
 *      absent / `[]` / malformed must all produce exactly the bytes 0.10.1
 *      produced. This is #228's C-1 discipline applied again.
 *   2. **The excluded key still reaches the model.** DEC-012 moves it, it
 *      does not hide it. `_` is the convention that hides, and it keeps its
 *      exact current meaning.
 *   3. **Excluding a key equals never having had it.** The prefix built
 *      with `page_id` excluded must be BYTE-EQUAL to the prefix of an IR
 *      whose context never carried `page_id` — that identity is precisely
 *      what makes a fan-out's branches collapse to one cache entry. The
 *      group-count proof of that collapse is in prewarm-fanout.test.ts.
 *
 * The prewarm grouping assertion (STEP-011) lives with the rest of the
 * prewarm suite; this file owns the prompt-assembly half.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleGenerate,
  handleAgenticGenerate,
  handleRepair,
  buildCacheablePrefix,
  MIN_CACHE_PREFIX_CHARS,
} from './step-handlers.js';

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

// Above MIN_CACHE_PREFIX_CHARS (4096) so the cached-prefix split fires.
const LONG_DOC = 'X'.repeat(5000);
const INSTRUCTION = 'Apply the ARCHITECTURE lens.';

function makeIr(overrides: Record<string, any> = {}): any {
  return {
    model: { id: 'omlx:qwen', max_tokens: 800 },
    system: 'You are an analyst.',
    policies: { grounding: { source: 'document' } },
    context: { document: LONG_DOC, lens: 'architecture', page_id: 'p-42' },
    ...overrides,
  };
}

const EMPTY_DOCS = { documents: [], groundingTextByKey: {} };

/** Capture what handleGenerate hands the provider. */
async function dispatch(ir: any, prompt: any = INSTRUCTION): Promise<any> {
  let captured: any;
  await handleGenerate(
    { id: 'g', prompt },
    ir,
    SCHEMA,
    (async (opts: any) => {
      captured = opts;
      return { text: '{"summary":"ok","tags":[]}' };
    }) as any,
    JSON.parse,
  );
  return captured;
}

/** Single-turn agentic run: no tools offered, so the loop takes the
 *  final-output branch immediately and the first request body is the whole
 *  story. */
async function agenticDispatch(ir: any): Promise<any> {
  let captured: any;
  const result = await handleAgenticGenerate(
    { id: 'g', prompt: INSTRUCTION },
    ir,
    SCHEMA,
    [],
    { defs: new Map() } as any,
    [],
    (async (opts: any) => {
      captured = opts;
      return {
        message: { content: '{"summary":"ok","tags":[]}', tool_calls: undefined },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }) as any,
    (t: string) => JSON.parse(t),
    /* maxToolCalls */ 2,
    {},
    EMPTY_DOCS,
  );
  expect(result.parsed).toEqual({ summary: 'ok', tags: [] });
  return captured;
}

const REPAIR_ERRORS = [{ instancePath: '/summary', message: 'Grounding: quote not found' }];
const REPAIRED = '{"summary":"fixed","tags":[]}';
const BROKEN = '{"summary":"wrong","tags":[]}';
const TASK = INSTRUCTION;

/** Capture what handleRepair hands the provider on the SEMANTIC path
 *  (`source` present). */
async function repairDispatch(ir: any): Promise<any> {
  let captured: any;
  const result = await handleRepair(
    BROKEN,
    REPAIR_ERRORS,
    SCHEMA,
    ir,
    1,
    (async (opts: any) => {
      captured = opts;
      return { text: REPAIRED };
    }) as any,
    JSON.parse,
    ir.model,
    { documents: [], groundingTextByKey: {}, task: TASK },
  );
  expect(result.parsed).toEqual({ summary: 'fixed', tags: [] });
  return captured;
}

describe('#182 byte-identity: a gen that declares nothing is unchanged', () => {
  // The frozen expectation, written out rather than derived, so a drift in
  // the assembler cannot silently drift the assertion with it.
  const UNDECLARED_PREFIX = [
    'DOCUMENT:',
    LONG_DOC,
    '',
    'LENS:',
    'architecture',
    '',
    'PAGE_ID:',
    'p-42',
    '',
    TEMPLATE_LABEL,
    JSON_TEMPLATE,
  ].join('\n');

  it('no excludeFromPrefix key → the pre-#182 prefix and prompt, byte-for-byte', async () => {
    const captured = await dispatch(makeIr());
    expect(captured.cachedPrefix).toBe(UNDECLARED_PREFIX);
    expect(captured.prompt).toBe(INSTRUCTION);
  });

  it.each([
    ['empty array', []],
    ['null', null],
    ['undefined', undefined],
    // A hand-built or precompiled (#195) IR can carry anything. Malformed
    // must degrade to "nothing excluded" — today's behavior — never throw
    // inside prompt assembly.
    ['a bare string instead of an array', 'page_id'],
    ['an object', { page_id: true }],
    ['an array of non-strings', [null, 42, { page_id: true }]],
  ])('excludeFromPrefix = %s → same bytes as no key at all', async (_label, value) => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: value }));
    expect(captured.cachedPrefix).toBe(UNDECLARED_PREFIX);
    expect(captured.prompt).toBe(INSTRUCTION);
  });

  it('naming a key that never arrives in context is a no-op', async () => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: ['never_supplied'] }));
    expect(captured.cachedPrefix).toBe(UNDECLARED_PREFIX);
    expect(captured.prompt).toBe(INSTRUCTION);
  });

  it('the excludedTail is the empty string when nothing is excluded', () => {
    const { excludedTail } = buildCacheablePrefix(makeIr(), SCHEMA, EMPTY_DOCS);
    expect(excludedTail).toBe('');
  });
});

describe('#182 the excluded key moves to the uncached tail (DEC-012)', () => {
  it('drops out of the prefix and lands after the instruction', async () => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: ['page_id'] }));

    expect(captured.cachedPrefix).toBe(
      [
        'DOCUMENT:',
        LONG_DOC,
        '',
        'LENS:',
        'architecture',
        '',
        TEMPLATE_LABEL,
        JSON_TEMPLATE,
      ].join('\n'),
    );
    // Same `\n\n` section separator the prefix uses, so the model sees the
    // section exactly as it would have seen it inside the prefix.
    expect(captured.prompt).toBe(`${INSTRUCTION}\n\nPAGE_ID:\np-42`);
  });

  it('the model still sees the value — it moved, it did not disappear', async () => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: ['page_id'] }));
    const everythingTheModelSees = `${captured.prompt}\n${captured.cachedPrefix}`;
    expect(everythingTheModelSees).toContain('PAGE_ID:');
    expect(everythingTheModelSees).toContain('p-42');
  });

  it('excluding a key is byte-equal to never having had it — the collapse identity', () => {
    const withExclusion = buildCacheablePrefix(
      makeIr({ excludeFromPrefix: ['page_id'] }),
      SCHEMA,
      EMPTY_DOCS,
    );
    const withoutTheKey = buildCacheablePrefix(
      makeIr({ context: { document: LONG_DOC, lens: 'architecture' } }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(withExclusion.cacheablePrefix).toBe(withoutTheKey.cacheablePrefix);
  });

  it('two calls differing only in the excluded value share one prefix', () => {
    const a = buildCacheablePrefix(
      makeIr({ excludeFromPrefix: ['page_id'], context: { document: LONG_DOC, page_id: 'p-1' } }),
      SCHEMA,
      EMPTY_DOCS,
    );
    const b = buildCacheablePrefix(
      makeIr({ excludeFromPrefix: ['page_id'], context: { document: LONG_DOC, page_id: 'p-999' } }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(a.cacheablePrefix).toBe(b.cacheablePrefix);
    // ...and the difference is preserved in the tail, not thrown away.
    expect(a.excludedTail).toBe('PAGE_ID:\np-1');
    expect(b.excludedTail).toBe('PAGE_ID:\np-999');
  });

  it('multiple excluded keys keep the prefix section layout in the tail', () => {
    const { excludedTail } = buildCacheablePrefix(
      makeIr({
        excludeFromPrefix: ['page_id', 'run_seq'],
        context: { document: LONG_DOC, page_id: 'p-42', run_seq: 7 },
      }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(excludedTail).toBe('PAGE_ID:\np-42\n\nRUN_SEQ:\n7');
  });

  it('an excluded `<key>_enriched` keeps its _ANALYSIS label', () => {
    const { excludedTail } = buildCacheablePrefix(
      makeIr({
        excludeFromPrefix: ['logs_enriched'],
        context: { document: LONG_DOC, logs_enriched: 'summary text' },
      }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(excludedTail).toBe('LOGS_ANALYSIS:\nsummary text');
  });
});

describe('#182 the `_` convention is untouched', () => {
  it('a `_` key is still hidden entirely — neither prefix nor tail', () => {
    const { cacheablePrefix, excludedTail } = buildCacheablePrefix(
      makeIr({
        excludeFromPrefix: ['page_id'],
        context: { document: LONG_DOC, page_id: 'p-42', _pipeline_arg: 'internal' },
      }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(cacheablePrefix).not.toContain('internal');
    expect(cacheablePrefix).not.toContain('_PIPELINE_ARG');
    expect(excludedTail).not.toContain('internal');
    expect(excludedTail).toBe('PAGE_ID:\np-42');
  });

  it('the grounding source itself is never excludable at runtime either', () => {
    // The compile error (DEC-013a) is the real gate; a hand-built IR that
    // gets past it must still keep the document in the prefix — the
    // fail-safe direction.
    const { cacheablePrefix, excludedTail } = buildCacheablePrefix(
      makeIr({ excludeFromPrefix: ['document'] }),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(cacheablePrefix).toContain(LONG_DOC);
    expect(excludedTail).not.toContain(LONG_DOC);
  });
});

// ── DEC-016: below the floor, the exclusion does not apply at all ─────
//
// AUD-182-001. DEC-012 justified the tail with "the provider orders
// [prefix][userText] and a cache region extends backward, so the tail is
// outside it" — true of the CACHE-AWARE path only. `legacyPrompt` is
// `${promptText}\n\n${cacheablePrefix}`, so on the legacy path the tail landed
// BEFORE the prefix, wedging the excluded sections between the instruction
// and `DOCUMENT:` for zero caching benefit. And the legacy path is where
// oMLX and Ollama — the documented defaults — always are, plus Anthropic
// below the floor. With RED-421 fallbacks one gen could show two orders in a
// single run.
//
// So: no cached path, no exclusion. Full prefix, empty tail, byte-identical
// to a gen that never declared anything.
describe('#182 DEC-016 — the non-cached paths do not exclude', () => {
  const TINY_DOC = 'two-line doc.';

  /** Identical IRs but for the declaration — the whole point is that below
   *  the floor a caller cannot tell them apart. */
  const belowFloor = (declared: boolean) =>
    makeIr({
      context: { document: TINY_DOC, page_id: 'p-42' },
      ...(declared ? { excludeFromPrefix: ['page_id'] } : {}),
    });

  it('below the floor: a declaring gen is byte-identical to a non-declaring one', async () => {
    const declared = await dispatch(belowFloor(true));
    const plain = await dispatch(belowFloor(false));

    expect(declared.cachedPrefix).toBeUndefined();
    expect(declared.prompt).toBe(plain.prompt);
    expect(declared.system).toBe(plain.system);
    // ...and that shared string is the pre-#182 layout: instruction, then
    // DOCUMENT, with PAGE_ID back inside the prefix where it started.
    expect(declared.prompt).toBe(
      [
        INSTRUCTION,
        '',
        'DOCUMENT:',
        TINY_DOC,
        '',
        'PAGE_ID:',
        'p-42',
        '',
        TEMPLATE_LABEL,
        JSON_TEMPLATE,
      ].join('\n'),
    );
  });

  it('below the floor, agentic path: same — declaring is indistinguishable', async () => {
    const irOf = (declared: boolean) => ({
      ...belowFloor(declared),
      mode: 'agentic',
      policies: {},
    });
    const declared = await agenticDispatch(irOf(true));
    const plain = await agenticDispatch(irOf(false));

    expect(declared.cachedPrefix).toBeUndefined();
    expect(declared.messages[1].content).toBe(plain.messages[1].content);
    expect(declared.messages[0].content).toBe(plain.messages[0].content);
  });

  it('below the floor, repair path: same — declaring is indistinguishable', async () => {
    const declared = await repairDispatch(belowFloor(true));
    const plain = await repairDispatch(belowFloor(false));

    expect(declared.cachedPrefix).toBeUndefined();
    expect(declared.prompt).toBe(plain.prompt);
    expect(declared.system).toBe(plain.system);
    expect(declared.prompt).not.toContain('TASK (the instruction that produced ORIGINAL_OUTPUT):\n' +
      'Apply the ARCHITECTURE lens.\n\nPAGE_ID:');
  });

  it('ungrounded single-shot gens are on the legacy path, so they do not exclude either', async () => {
    // Prefix is 5 KB — over the floor — but ungrounded, so `eligible` is
    // false and the cached path is never taken. DEC-016 applies on the
    // eligibility half of the gate too, not just the size half.
    const captured = await dispatch(makeIr({ policies: {}, excludeFromPrefix: ['page_id'] }));
    const plain = await dispatch(makeIr({ policies: {} }));
    expect(captured.cachedPrefix).toBeUndefined();
    expect(captured.prompt).toBe(plain.prompt);
  });

  it('the returned tail is empty and the prefix is whole', () => {
    const { cacheablePrefix, excludedTail, useCachedPrefix } = buildCacheablePrefix(
      belowFloor(true),
      SCHEMA,
      EMPTY_DOCS,
    );
    expect(useCachedPrefix).toBe(false);
    expect(excludedTail).toBe('');
    expect(cacheablePrefix).toContain('PAGE_ID:');
  });

  it('above the floor the exclusion still applies — DEC-016 is scoped to the legacy path', async () => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: ['page_id'] }));
    expect(captured.cachedPrefix).toBeDefined();
    expect(captured.cachedPrefix).not.toContain('PAGE_ID:');
    expect(captured.prompt).toBe(`${INSTRUCTION}\n\nPAGE_ID:\np-42`);
  });

  // AUD-182-003. The old ternary produced `"\n\nPAGE_ID:\np-42"` here — a
  // prompt whose first two characters are a blank line. Filtering instead
  // drops the empty instruction; every other input is byte-identical.
  it('an absent step.prompt no longer leaves the prompt starting with a blank line', async () => {
    const captured = await dispatch(makeIr({ excludeFromPrefix: ['page_id'] }), null);
    expect(captured.prompt).toBe('PAGE_ID:\np-42');
    // AUD-R2-001: the literal word "null" must never reach the prompt.
    expect(captured.prompt).not.toContain('null');
  });

  it('an absent step.prompt with nothing excluded is still the empty string', async () => {
    const captured = await dispatch(makeIr(), null);
    expect(captured.prompt).toBe('');
  });
});

// ── DEC-017: the cached-prefix decision is observable ─────────────────
//
// AUD-182-002. Excluding a large key can drop the prefix below the floor and
// turn caching OFF — the inverse of the author's intent — and until now
// `useCachedPrefix` reached no trace field anywhere. Not a new gate: the
// trade-off is the author's, the defect was that it was invisible.
describe('#182 DEC-017/DEC-018 — cache_prefix on the Generate step', () => {
  /** A doc that clears the floor only WITH the big excludable key present. */
  const DOC_2K = 'A'.repeat(2500);
  const NOTES_2K = 'N'.repeat(1800);
  const invertedIr = (declared: boolean) =>
    makeIr({
      context: { document: DOC_2K, notes: NOTES_2K },
      ...(declared ? { excludeFromPrefix: ['notes'] } : {}),
    });

  async function generateStep(ir: any): Promise<any> {
    const { result } = await handleGenerate(
      { id: 'g', prompt: INSTRUCTION },
      ir,
      SCHEMA,
      (async () => ({ text: '{"summary":"ok","tags":[]}' })) as any,
      JSON.parse,
    );
    return result;
  }

  // DEC-018: `judged_chars`, not `chars`. `toEqual` on the whole object is
  // the pin — a stray extra key or a revived `chars` fails here, and the
  // trace vocabulary is COMPATIBILITY surface 4.
  it('reports judged_chars / used / excluded_chars on every Generate step', async () => {
    const step = await generateStep(makeIr());
    expect(step.meta.cache_prefix).toEqual({
      judged_chars: expect.any(Number),
      used: true,
      excluded_chars: 0,
    });
    expect(step.meta.cache_prefix).not.toHaveProperty('chars');
  });

  it('excluded_chars is 0 for a gen that declares nothing', async () => {
    const step = await generateStep(makeIr());
    expect(step.meta.cache_prefix.excluded_chars).toBe(0);
  });

  it('excluded_chars counts the bytes the declaration removed from the prefix', async () => {
    const withDecl = buildCacheablePrefix(
      makeIr({ excludeFromPrefix: ['page_id'] }),
      SCHEMA,
      EMPTY_DOCS,
    );
    const without = buildCacheablePrefix(makeIr(), SCHEMA, EMPTY_DOCS);
    expect(withDecl.cachePrefix.excluded_chars).toBe(
      without.cacheablePrefix.length - withDecl.cachePrefix.judged_chars,
    );
    expect(withDecl.cachePrefix.excluded_chars).toBeGreaterThan(0);
  });

  it('judged_chars is the length the floor gate judged — exclusion applied, even when unused', () => {
    const below = buildCacheablePrefix(
      makeIr({
        excludeFromPrefix: ['page_id'],
        context: { document: 'tiny.', page_id: 'p-42' },
      }),
      SCHEMA,
      EMPTY_DOCS,
    );
    // DEC-016 ships the whole prefix, but the DECISION was made on the
    // shorter one. DEC-018: the field is named for exactly this gap — it
    // reports what was JUDGED, not what was sent.
    expect(below.cachePrefix.used).toBe(false);
    expect(below.cachePrefix.judged_chars).toBeLessThan(below.cacheablePrefix.length);
    // The shipped length stays derivable without a second field:
    // judged + excluded when caching is off.
    expect(below.cachePrefix.judged_chars + below.cachePrefix.excluded_chars).toBe(
      below.cacheablePrefix.length,
    );
  });

  it('the inversion: a declaration flips used from true to false', () => {
    const off = buildCacheablePrefix(invertedIr(false), SCHEMA, EMPTY_DOCS);
    const on = buildCacheablePrefix(invertedIr(true), SCHEMA, EMPTY_DOCS);
    expect(off.cachePrefix.used).toBe(true);
    expect(off.cachePrefix.judged_chars).toBeGreaterThanOrEqual(MIN_CACHE_PREFIX_CHARS);
    expect(on.cachePrefix.used).toBe(false);
    expect(on.cachePrefix.judged_chars).toBeLessThan(MIN_CACHE_PREFIX_CHARS);
    expect(on.exclusionCostCaching).toBe(true);
  });

  it('warns on stderr exactly for the inverted case', async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((c: any) => (writes.push(String(c)), true)) as any);
    try {
      await generateStep(invertedIr(true));
    } finally {
      spy.mockRestore();
    }
    const warning = writes.find((w) => w.includes('exclude_from_prefix turned prompt caching OFF'));
    expect(warning).toBeDefined();
    expect(warning).toContain(String(MIN_CACHE_PREFIX_CHARS));
  });

  it.each([
    ['a gen that declares nothing', () => invertedIr(false)],
    ['a declaration that never cleared the floor either way', () =>
      makeIr({ excludeFromPrefix: ['page_id'], context: { document: 'tiny.', page_id: 'p-42' } })],
    ['a declaration that leaves the prefix above the floor', () =>
      makeIr({ excludeFromPrefix: ['page_id'] })],
    ['an ungrounded gen, which was never going to cache', () =>
      makeIr({ policies: {}, excludeFromPrefix: ['page_id'] })],
  ])('stays silent for %s', async (_label, mk) => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((c: any) => (writes.push(String(c)), true)) as any);
    try {
      await generateStep(mk());
    } finally {
      spy.mockRestore();
    }
    expect(writes.some((w) => w.includes('turned prompt caching OFF'))).toBe(false);
  });
});

describe('#182 the agentic dispatch site (mode :agentic)', () => {
  // The agentic path passes `includeOutputTemplate: false` (DEC-008), so
  // its prefix ends at the last context section.
  const AGENTIC_UNDECLARED_PREFIX = [
    'DOCUMENT:',
    LONG_DOC,
    '',
    'LENS:',
    'architecture',
    '',
    'PAGE_ID:',
    'p-42',
  ].join('\n');

  it('no declaration → byte-identical to pre-#182', async () => {
    const captured = await agenticDispatch(makeIr({ mode: 'agentic', policies: {} }));
    expect(captured.cachedPrefix).toBe(AGENTIC_UNDECLARED_PREFIX);
    expect(captured.messages[1].content).toBe(INSTRUCTION);
  });

  it('the excluded key leaves the prefix and rides the user message', async () => {
    const captured = await agenticDispatch(
      makeIr({ mode: 'agentic', policies: {}, excludeFromPrefix: ['page_id'] }),
    );
    expect(captured.cachedPrefix).toBe(
      ['DOCUMENT:', LONG_DOC, '', 'LENS:', 'architecture'].join('\n'),
    );
    expect(captured.messages[1].content).toBe(`${INSTRUCTION}\n\nPAGE_ID:\np-42`);
  });
});

// ── DEC-014: the fourth caller ────────────────────────────────────────
//
// `buildCacheablePrefix` has FOUR callers, not two: the two dispatch sites,
// `prewarmFanOut` (which discards `excludedTail` — that discard IS the
// collapse), and `handleRepair`. STEP-010's "both dispatch sites" missed the
// last one. Without the tail, a gen that declares
// `exclude_from_prefix` would have those sections in NEITHER the prefix nor
// the tail on the repair path — repair seeing less than Generate did is the
// exact failure RED-175 exists to prevent.
//
// The safety argument is that appending to an already-uncached tail cannot
// move the prompt-cache key RED-175 protects at step-handlers.ts:585-592.
// That is asserted below, not assumed — it is the whole reason this is free.
describe('#182 DEC-014 — semantic repair receives the excluded tail', () => {
  // The repair-specific blocks, frozen. Shared by both expectations below so
  // the ONLY difference between them is the excluded section.
  const REPAIR_BLOCKS = [
    'ORIGINAL_OUTPUT (already produced; may be invalid):',
    BROKEN,
    '',
    'VALIDATION_ERRORS:',
    '/summary: Grounding: quote not found',
    '',
    'REPAIR RULES:',
    '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
    '- Output must start with "{" and end with "}".',
    '- Edit ONLY the fields named in VALIDATION_ERRORS.',
    '- Fix every cited quote to text that appears VERBATIM in DOCUMENT above —',
    '  copy it exactly, including punctuation.',
    '- Never delete a citation or a grounded value; correct it instead.',
    '- Keep every key from OUTPUT_JSON_TEMPLATE. Add none.',
    '',
    'Return repaired JSON only.',
  ];

  it('no declaration → the repair prompt is byte-identical to pre-#182', async () => {
    const captured = await repairDispatch(makeIr());
    expect(captured.prompt).toBe(
      [
        'TASK (the instruction that produced ORIGINAL_OUTPUT):',
        TASK,
        '',
        ...REPAIR_BLOCKS,
      ].join('\n'),
    );
    // ...and the excluded-key candidates are still where they always were.
    expect(captured.cachedPrefix).toContain('PAGE_ID:');
  });

  it('with a declaration → the sections land right after TASK, before ORIGINAL_OUTPUT', async () => {
    const captured = await repairDispatch(makeIr({ excludeFromPrefix: ['page_id'] }));
    expect(captured.prompt).toBe(
      [
        'TASK (the instruction that produced ORIGINAL_OUTPUT):',
        TASK,
        '',
        'PAGE_ID:',
        'p-42',
        '',
        ...REPAIR_BLOCKS,
      ].join('\n'),
    );
    // The prefix gave it up; the tail picked it up. Repair sees exactly what
    // Generate saw, which is the RED-175 contract.
    expect(captured.cachedPrefix).not.toContain('PAGE_ID:');
    expect(`${captured.prompt}\n${captured.cachedPrefix}`).toContain('p-42');
  });

  // The load-bearing safety claim: the tail is outside the SHARED USER-PREFIX
  // cache region — the one keyed on `cachedPrefix` — so touching it cannot
  // move that key. (Not "outside the cached region" full stop: on the agentic
  // path Anthropic's automatic breakpoint covers the first user message from
  // turn 2. Different region. AUD-182-004.) Compared against the cachedPrefix the
  // GENERATE step sent for the same IR — which is the property
  // step-handlers.ts:585-592 exists to hold.
  it.each([
    ['a non-declaring gen', undefined],
    ['a declaring gen', ['page_id']],
  ])('%s: repair rides generate\'s cache entry — same system, same cachedPrefix', async (
    _label,
    excludeFromPrefix,
  ) => {
    const ir = makeIr(excludeFromPrefix ? { excludeFromPrefix } : {});
    const gen = await dispatch(ir);
    const rep = await repairDispatch(ir);

    expect(rep.system).toBe(gen.system);
    expect(rep.cachedPrefix).toBe(gen.cachedPrefix);
    expect(rep.cachedPrefix).toContain('DOCUMENT:');
  });

  // DEC-016 superseded this: below the floor there is no tail at all, so the
  // repair prompt is the pre-#182 one. Kept here because the repair path has
  // its OWN prefix/tail ordering (`[cacheablePrefix, '', ...tail]`) and is
  // the caller most likely to regrow a tail by accident.
  it('below the cache floor: no tail, and the prefix keeps the key (DEC-016)', async () => {
    const tinyDoc = 'two-line doc.';
    const captured = await repairDispatch(
      makeIr({
        excludeFromPrefix: ['page_id'],
        context: { document: tinyDoc, page_id: 'p-42' },
      }),
    );
    expect(captured.cachedPrefix).toBeUndefined();
    expect(captured.prompt).toBe(
      [
        'DOCUMENT:',
        tinyDoc,
        '',
        'PAGE_ID:',
        'p-42',
        '',
        TEMPLATE_LABEL,
        JSON_TEMPLATE,
        '',
        'TASK (the instruction that produced ORIGINAL_OUTPUT):',
        TASK,
        '',
        ...REPAIR_BLOCKS,
      ].join('\n'),
    );
  });

  it('structural repair stays context-free — no excluded section leaks in', async () => {
    let captured: any;
    await handleRepair(
      BROKEN,
      [{ instancePath: '/', keyword: 'required', params: { missingProperty: 'summary' } }],
      SCHEMA,
      makeIr({ excludeFromPrefix: ['page_id'] }),
      1,
      (async (opts: any) => {
        captured = opts;
        return { text: REPAIRED };
      }) as any,
      JSON.parse,
      // No `source` → the lean, context-free structural prompt.
    );
    expect(captured.prompt).not.toContain('PAGE_ID:');
    expect(captured.prompt).not.toContain('p-42');
    expect(captured.prompt).not.toContain('DOCUMENT:');
    expect(captured.cachedPrefix).toBeUndefined();
  });
});
