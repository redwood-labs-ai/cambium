/**
 * Fan-out cache prewarm — grouping, gating, byte-identity, best-effort.
 *
 *   - fanOutPrewarmEligible: the gate that decides whether a fan-out primes
 *     its cache at all (opt-out / mock / single-worker / single-branch).
 *   - prewarmFanOut: one warm-up per distinct (model tier × prefix), the
 *     warm-up's (system, cachedPrefix) byte-identical to what a branch
 *     builds, ineligible branches excluded, and a thrown warm-up swallowed.
 *     Nothing is shared → nothing is warmed (RED-183).
 *
 * The byte-identity assertion is the load-bearing one: if the warm-up's
 * prefix drifts from the branch's by a single byte, the cache write lands
 * on a different key and the whole optimization is a no-op. The RED-183
 * cases are its mirror image — a fan-out where the optimization is a no-op
 * by construction, so it must cost zero calls instead of N.
 */

import { describe, it, expect, vi } from 'vitest';
import { prewarmFanOut, fanOutPrewarmEligible } from './pipeline.js';
import { buildGenSystem, buildCacheablePrefix, handleGenerate } from './step-handlers.js';
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
      // A and C share the cacheable surface; B contributes nothing.
      ['C::review', reviewerIr('anthropic:claude-opus-4-6')],
    ]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B'), branch('c', 'C')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    // One group, one warm-up — the excluded branch is neither a group nor a
    // call, and the two that remain still share.
    expect(summary).toEqual({ groups: 1, fired: 1, failed: 0, tokens: 0 });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('agentic branch is excluded from warming (#228, DEC-005)', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    // Three plain reviewers sharing a prefix, plus one `mode: agentic`
    // branch with a system of its own — so without the exclusion it forms
    // a second group and buys a second warm-up call. The real agentic call
    // sends a tools array and prewarm's generateText does not, so the entry
    // that second call writes is unreadable by the branch that paid for it.
    const memo = new Map([
      ['A::review', reviewerIr('anthropic:claude-opus-4-6')],
      ['B::review', reviewerIr('anthropic:claude-opus-4-6')],
      ['C::review', reviewerIr('anthropic:claude-opus-4-6')],
      ['D::review', reviewerIr('anthropic:claude-opus-4-6', {
        mode: 'agentic',
        system: 'You are an agentic reviewer.',
      })],
    ]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B'), branch('c', 'C'), branch('d', 'D')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    // One group, one call. Pre-#228 this was two groups and two calls.
    expect(summary).toEqual({ groups: 1, fired: 1, failed: 0, tokens: 0 });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('an agentic branch is not counted as evidence of a shared prefix (RED-183 invariant)', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    // One non-agentic branch and two agentic ones sharing its surface. If
    // the agentic branches were excluded AFTER `eligible++`, eligible would
    // be 3 against 1 group and the fan-out would fire a warm-up exactly one
    // branch can read. Excluded before, groups(1) >= eligible(1) → skipped.
    const memo = new Map([
      ['A::review', reviewerIr('anthropic:claude-opus-4-6')],
      ['B::review', reviewerIr('anthropic:claude-opus-4-6', { mode: 'agentic' })],
      ['C::review', reviewerIr('anthropic:claude-opus-4-6', { mode: 'agentic' })],
    ]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B'), branch('c', 'C')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary).toEqual({
      groups: 1,
      fired: 0,
      failed: 0,
      tokens: 0,
      skipped: 'no-shared-prefix',
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it('no shared prefix → nothing warmed, reason recorded (RED-183)', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    // Three grounded branches, all above the cache floor, none sharing a
    // prefix (each carries its own system) → three singleton groups. This is
    // the 200-page reviewer sweep: before RED-183 it fired 200 warm-ups that
    // cached nothing any other branch would read.
    const memo = new Map(
      ['A', 'B', 'C'].map((a) => [
        `${a}::review`,
        reviewerIr('anthropic:claude-opus-4-6', { system: `You are reviewer ${a}.` }),
      ]),
    );
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B'), branch('c', 'C')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary).toEqual({
      groups: 3,
      fired: 0,
      failed: 0,
      tokens: 0,
      skipped: 'no-shared-prefix',
    });
    expect(gen).not.toHaveBeenCalled();
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
    // Zero groups is its own outcome — distinct from "groups found but none
    // shared" — and stays byte-identical to pre-RED-183 (no `skipped` key).
    expect(summary).toEqual({ groups: 0, fired: 0, failed: 0, tokens: 0 });
    expect(gen).not.toHaveBeenCalled();
  });

  it('a branch missing from the memo (compile failure) is excluded', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const memo = new Map([
      ['A::review', reviewerIr('anthropic:claude-opus-4-6')],
      ['C::review', reviewerIr('anthropic:claude-opus-4-6')],
      // B absent → its compile failed; runBranch recompiles and surfaces it.
    ]);
    const summary = await prewarmFanOut(
      [branch('a', 'A'), branch('b', 'B'), branch('c', 'C')],
      memo,
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary).toEqual({ groups: 1, fired: 1, failed: 0, tokens: 0 });
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
      // C shares A's prefix, so the group has two members and gets warmed.
      ['C::review', reviewerIr('anthropic:claude-opus-4-6')],
    ]);
    await prewarmFanOut([branch('a', 'A'), branch('c', 'C')], memo, PASS_CONTEXT, makeCtx(gen));
    expect(captured).toHaveLength(1);
    expect(captured[0].fallbacks).toEqual(['bedrock:anthropic.claude-opus-4-6']);
  });
});

// ── #182: the collapse `exclude_from_prefix` exists to buy ─────────────
//
// This is the payoff assertion for the whole primitive, and the shape #182
// was filed about: a reviewer fan-out where every branch carries a
// per-branch key (`page_id`, from a pipeline `fan_out` binding) alongside a
// large shared grounded document.
//
// Before: that one key is inside the cacheable prefix, so every branch
// hashes to its own group. `groups === eligible` — nothing is shared, the
// RED-183 gate fires, prewarm is skipped entirely, and all N branches race
// cold for the same document. The 200-branch sweep in the issue is exactly
// this, at N=200.
//
// After: the gen declares `exclude_from_prefix :page_id`, the key moves to
// the uncached tail (DEC-012), and all N branches collapse to ONE group
// that actually gets warmed. Asserted on the group count directly — the
// number is the feature.
//
// Model-visibility of the excluded key is not this file's job; the
// dispatch-site half is pinned in exclude-from-prefix.test.ts.
//
// Non-agentic sub-gens on purpose: #228 DEC-005 excludes `mode: agentic`
// branches before they can group at all.
describe('#182 prewarm collapse: branches differing only in an excluded key', () => {
  // AUD-182-005: shaped like the DSL actually compiles. `expandBranches`
  // attaches `_context` only on the HOMOGENEOUS `fan_out` form —
  // `agent PageReviewer, method: :review; over [...], as: :page_id` — which
  // by definition is ONE agent with N bindings. Five distinct agents each
  // carrying `_context` is a configuration no `.pipeline.rb` can produce.
  // The grouping math is the same either way; the fixture should still be
  // reachable.
  const PER_PAGE = Array.from({ length: 5 }, (_, i) => ({
    ...branch(`p${i + 1}`, 'PageReviewer'),
    _context: { page_id: `page-${i + 1}` },
  }));

  /** One reviewer IR, five bindings — so the only thing that can split the
   *  branches into separate groups is the per-branch `page_id`. */
  function perPageMemo(excludeFromPrefix?: string[]): Map<string, any> {
    const overrides = excludeFromPrefix ? { excludeFromPrefix } : {};
    return new Map([
      ['PageReviewer::review', reviewerIr('anthropic:claude-sonnet-4-6', overrides)],
    ]);
  }

  it('BEFORE — without the declaration: 5 branches → 5 groups, nothing shared, nothing warmed', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const summary = await prewarmFanOut(PER_PAGE, perPageMemo(), PASS_CONTEXT, makeCtx(gen));

    expect(summary.groups).toBe(5);
    // groups === eligible → the RED-183 "no shared cacheable prefix" gate.
    expect(summary).toEqual({
      groups: 5,
      fired: 0,
      failed: 0,
      tokens: 0,
      skipped: 'no-shared-prefix',
    });
    expect(gen).not.toHaveBeenCalled();
  });

  it('AFTER — with `exclude_from_prefix :page_id`: 5 branches → 1 group, warmed once', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const summary = await prewarmFanOut(
      PER_PAGE,
      perPageMemo(['page_id']),
      PASS_CONTEXT,
      makeCtx(gen),
    );

    // The number that is the feature: branchCount → 1.
    expect(summary.groups).toBe(1);
    expect(summary).toEqual({ groups: 1, fired: 1, failed: 0, tokens: 0 });
    expect(gen).toHaveBeenCalledTimes(1);

    // AUD-182-005: the assertion that actually matters is not "the prefix
    // lacks PAGE_ID" — it is that the warmed bytes are EXACTLY what a
    // declaring branch's own dispatch builds. A cache entry keyed on
    // anything else is unreadable, which is the same no-op the fan-out had
    // before the declaration. Byte-compared against `handleGenerate`'s real
    // `cachedPrefix`, on the same merged IR runBranch would construct.
    const warmed = (gen.mock.calls[0] as any)[0];

    const mergedIr = {
      ...reviewerIr('anthropic:claude-sonnet-4-6', { excludeFromPrefix: ['page_id'] }),
      context: { ...PASS_CONTEXT, ...PER_PAGE[0]._context },
    };
    let branchOpts: any;
    await handleGenerate(
      { id: 'g', prompt: 'Review this page.' },
      mergedIr,
      SCHEMA,
      (async (opts: any) => ((branchOpts = opts), { text: '{"summary":"ok"}' })) as any,
      JSON.parse,
      await extractDocuments(mergedIr),
    );
    expect(warmed.system).toBe(branchOpts.system);
    expect(warmed.cachedPrefix).toBe(branchOpts.cachedPrefix);

    // ...and the excluded key is where DEC-012 puts it: out of the warmed
    // prefix, into the branch's own uncached tail.
    expect(warmed.cachedPrefix).not.toContain('PAGE_ID:');
    expect(warmed.cachedPrefix).toContain('DOCUMENT:');
    expect(warmed.cachedPrefix).toContain('DIFF_SURFACE:');
    expect(branchOpts.prompt).toBe('Review this page.\n\nPAGE_ID:\npage-1');
  });

  it('scales: 200 branches → 1 group (the shape in the issue)', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...branch(`p${i}`, 'PageReviewer'),
      _context: { page_id: `page-${i}` },
    }));
    const memo = perPageMemo(['page_id']);
    const summary = await prewarmFanOut(many, memo, PASS_CONTEXT, makeCtx(gen));
    expect(summary).toEqual({ groups: 1, fired: 1, failed: 0, tokens: 0 });
  });

  it('excluding an unrelated key does NOT collapse them — the exclusion has to name the varying key', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    const summary = await prewarmFanOut(
      PER_PAGE,
      perPageMemo(['some_other_key']),
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary.groups).toBe(5);
    expect(gen).not.toHaveBeenCalled();
  });

  it('a genuinely differing key still splits the groups — the exclusion is scoped, not a blanket', async () => {
    const gen = vi.fn(async () => ({ text: '{}' }));
    // Same `exclude_from_prefix :page_id`, but the branches ALSO differ in
    // `lens`, which stays in the prefix. Two lenses → two groups, and each
    // group has members, so both get warmed.
    const branches = PER_PAGE.map((b, i) => ({
      ...b,
      _context: { page_id: `page-${i + 1}`, lens: i % 2 === 0 ? 'security' : 'performance' },
    }));
    const summary = await prewarmFanOut(
      branches,
      perPageMemo(['page_id']),
      PASS_CONTEXT,
      makeCtx(gen),
    );
    expect(summary).toEqual({ groups: 2, fired: 2, failed: 0, tokens: 0 });
  });
});
