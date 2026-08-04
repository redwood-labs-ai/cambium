/**
 * Fan-out cache prewarm — grouping, gating, byte-identity, best-effort.
 *
 *   - fanOutPrewarmEligible: the gate that decides whether a fan-out primes
 *     its cache at all (opt-out / mock / single-worker / single-branch).
 *   - prewarmFanOut: one warm-up per distinct (model tier × prefix), the
 *     warm-up's (system, cachedPrefix) byte-identical to what a branch
 *     builds, ineligible branches excluded, and a thrown warm-up swallowed.
 *
 * The byte-identity assertion is the load-bearing one: if the warm-up's
 * prefix drifts from the branch's by a single byte, the cache write lands
 * on a different key and the whole optimization is a no-op.
 */

import { describe, it, expect, vi } from 'vitest';
import { prewarmFanOut, fanOutPrewarmEligible } from './pipeline.js';
import { buildGenSystem, buildCacheablePrefix } from './step-handlers.js';
import { extractDocuments } from './documents.js';

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary'],
};

// Above MIN_CACHE_PREFIX_CHARS (4096) so useCachedPrefix fires.
const LONG_DIFF = 'D'.repeat(6000);
const PASS_CONTEXT = { raw_diff: LONG_DIFF, diff_surface: 'ruby_dsl, runner' };

const UNIFIED_SYSTEM = 'You are a unified reviewer.';

/** A reviewer sub-IR: shared system + returns + grounding, raw_diff arrives
 *  via context (empty own context), tier set by model id. */
function reviewerIr(modelId: string, overrides: Record<string, any> = {}): any {
  return {
    id: 'reviewer',
    model: { id: modelId, temperature: 0.1, max_tokens: 4096 },
    system: UNIFIED_SYSTEM,
    policies: { grounding: { source: 'raw_diff' } },
    context: {},
    returnSchema: SCHEMA,
    ...overrides,
  };
}

function branch(id: string, agent: string): any {
  return { id, agent, method: 'review' };
}

/** ctx stub — prewarmFanOut only touches generateText + contractsMod. */
function makeCtx(generateText: any): any {
  return { generateText, contractsMod: {} };
}

// Five reviewers across two tiers, all sharing the cacheable surface.
const FIVE_BRANCHES = [
  branch('architecture', 'ArchReviewer'),
  branch('semantic', 'SemanticReviewer'),
  branch('performance', 'PerfReviewer'),
  branch('security', 'SecurityReviewer'),
  branch('quality', 'QualityReviewer'),
];
function fiveBranchMemo(): Map<string, any> {
  return new Map([
    ['ArchReviewer::review', reviewerIr('anthropic:claude-opus-4-6')],
    ['SemanticReviewer::review', reviewerIr('anthropic:claude-sonnet-4-6')],
    ['PerfReviewer::review', reviewerIr('anthropic:claude-sonnet-4-6')],
    ['SecurityReviewer::review', reviewerIr('anthropic:claude-opus-4-6')],
    ['QualityReviewer::review', reviewerIr('anthropic:claude-sonnet-4-6')],
  ]);
}

describe('fanOutPrewarmEligible', () => {
  const op = {}; // prewarm unset → default on

  it('multi-branch, concurrency > 1, not mock → eligible', () => {
    expect(fanOutPrewarmEligible(op, 5, 5, false)).toBe(true);
  });
  it('concurrency 1 → not eligible (branch 1 warms the rest)', () => {
    expect(fanOutPrewarmEligible(op, 1, 5, false)).toBe(false);
  });
  it('single branch → not eligible', () => {
    expect(fanOutPrewarmEligible(op, 5, 1, false)).toBe(false);
  });
  it('--mock → not eligible (no real cache)', () => {
    expect(fanOutPrewarmEligible(op, 5, 5, true)).toBe(false);
  });
  it('prewarm: false → not eligible', () => {
    expect(fanOutPrewarmEligible({ prewarm: false }, 5, 5, false)).toBe(false);
  });
});

describe('prewarmFanOut', () => {
  it('5 branches / 2 tiers → exactly 2 warm-ups, each tiny max_tokens', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const summary = await prewarmFanOut(FIVE_BRANCHES, fiveBranchMemo(), PASS_CONTEXT, makeCtx(gen));

    expect(summary).toEqual({ groups: 2, fired: 2, failed: 0, tokens: 0 });
    expect(gen).toHaveBeenCalledTimes(2);
    const models = gen.mock.calls.map((c: any) => c[0].model).sort();
    expect(models).toEqual(['anthropic:claude-opus-4-6', 'anthropic:claude-sonnet-4-6']);
    for (const [opts] of gen.mock.calls as any) {
      expect(opts.max_tokens).toBe(16);
      expect(opts.cachedPrefix).toBeDefined();
      expect(opts.jsonSchema).toBe(SCHEMA);
      expect(opts.temperature).toBe(0.1);
    }
  });

  it('byte-identity: warm-up (system, cachedPrefix) equals what the branch builds', async () => {
    const captured: any[] = [];
    const gen = vi.fn(async (opts: any) => {
      captured.push(opts);
      return { text: '{}' };
    });
    await prewarmFanOut(FIVE_BRANCHES, fiveBranchMemo(), PASS_CONTEXT, makeCtx(gen));

    // Reproduce exactly what a branch's merged IR would build.
    const mergedIr = {
      ...reviewerIr('anthropic:claude-opus-4-6'),
      context: { ...PASS_CONTEXT },
    };
    const docInput = await extractDocuments(mergedIr);
    const expectedSystem = buildGenSystem(mergedIr, SCHEMA);
    const { cacheablePrefix: expectedPrefix } = buildCacheablePrefix(mergedIr, SCHEMA, docInput);

    // Every warm-up shares system+prefix here (only the model tier differs).
    for (const opts of captured) {
      expect(opts.system).toBe(expectedSystem);
      expect(opts.cachedPrefix).toBe(expectedPrefix);
    }
    // The prefix carries the diff + the non-primary diff_surface section.
    expect(captured[0].cachedPrefix).toContain('DOCUMENT:');
    expect(captured[0].cachedPrefix).toContain('DIFF_SURFACE:');
  });

  it('ungrounded branch is excluded from warming', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const memo = new Map([
      ['A::review', reviewerIr('anthropic:claude-opus-4-6')],
      // same tier, but no grounding → not a cacheable-prefix gen
      ['B::review', reviewerIr('anthropic:claude-opus-4-6', { policies: {} })],
    ]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary.groups).toBe(1);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('sub-floor prefix is excluded from warming', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const memo = new Map([['A::review', reviewerIr('anthropic:claude-opus-4-6')]]);
    // Tiny diff → prefix below MIN_CACHE_PREFIX_CHARS.
    const summary = await prewarmFanOut(
      [branch('a', 'A')],
      memo,
      { raw_diff: 'tiny diff' },
      makeCtx(gen),
    );
    expect(summary.groups).toBe(0);
    expect(gen).not.toHaveBeenCalled();
  });

  it('a branch missing from the memo (compile failure) is excluded', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const memo = new Map([['A::review', reviewerIr('anthropic:claude-opus-4-6')]]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B')], // B not in memo
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary.groups).toBe(1);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a thrown warm-up is swallowed — summary records failed, no rejection', async () => {
    const gen = vi.fn(async () => {
      throw new Error('provider down');
    });
    const summary = await prewarmFanOut(FIVE_BRANCHES, fiveBranchMemo(), PASS_CONTEXT, makeCtx(gen));
    expect(summary).toEqual({ groups: 2, fired: 0, failed: 2, tokens: 0 });
  });

  it('a branch whose prefix-build throws is skipped, not fatal — others still warm', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    // The bad IR is missing `model` → the group-key line (subIr.model.id)
    // throws synchronously. It must be swallowed, not fail the fan-out.
    const bad = reviewerIr('anthropic:claude-opus-4-6');
    delete bad.model;
    const memo = new Map([
      ['Good::review', reviewerIr('anthropic:claude-sonnet-4-6')],
      ['Bad::review', bad],
    ]);
    const summary = await prewarmFanOut(
      [branch('good', 'Good'), branch('bad', 'Bad')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary.groups).toBe(1);
    expect(gen).toHaveBeenCalledTimes(1);
    expect((gen.mock.calls[0] as any)[0].model).toBe('anthropic:claude-sonnet-4-6');
  });

  it('sums warm-up token spend into the summary', async () => {
    const gen = vi.fn(async () => ({ text: '{}', usage: { total_tokens: 34_000 } }));
    const summary = await prewarmFanOut(FIVE_BRANCHES, fiveBranchMemo(), PASS_CONTEXT, makeCtx(gen));
    // 2 tiers × 34k each.
    expect(summary.tokens).toBe(68_000);
  });

  it('passes fallbacks through so a warm-up survives a transient primary failure', async () => {
    const captured: any[] = [];
    const gen = vi.fn(async (opts: any) => {
      captured.push(opts);
      return { text: '{}' };
    });
    const memo = new Map([
      [
        'A::review',
        reviewerIr('anthropic:claude-opus-4-6', {
          model: {
            id: 'anthropic:claude-opus-4-6',
            temperature: 0.1,
            fallbacks: ['bedrock:anthropic.claude-opus-4-6'],
          },
        }),
      ],
    ]);
    await prewarmFanOut([branch('a', 'A')], memo, PASS_CONTEXT, makeCtx(gen));
    expect(captured[0].fallbacks).toEqual(['bedrock:anthropic.claude-opus-4-6']);
  });
});
