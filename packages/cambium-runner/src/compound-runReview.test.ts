import { describe, it, expect, vi } from 'vitest';
import { runReview } from './compound.js';

const noopExtract = (text: string) => {
  try { return JSON.parse(text); } catch { return {}; }
};

const minimalIr = {
  model: { id: 'omlx:mock' },
  policies: { grounding: { source: 'document' } },
  context: { document: 'source text' },
};

describe('runReview (RED-325 Parts 1 + 2)', () => {
  describe('Part 2: try/catch + skipped_reason shape', () => {
    it('returns ok-false with skipped_reason when generateText throws', async () => {
      const generateText = vi.fn().mockRejectedValue(new Error('provider down'));
      const result = await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
      );
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([]);
      expect(result.raw_preview).toBe('');
      expect(result.usage).toBeUndefined();
      expect(result.meta).toEqual({
        skipped_reason: 'provider_error',
        error: 'provider down',
      });
      // Time still measured even on failure
      expect(typeof result.ms).toBe('number');
    });

    it('does NOT set skipped_reason when call succeeds but output is unparseable', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: 'not json' });
      const result = await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
      );
      // ok-true: review ran, just produced no parseable issues
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.meta).toBeUndefined();
    });

    it('returns ok-false (with issues) when review found real problems', async () => {
      const generateText = vi.fn().mockResolvedValue({
        text: JSON.stringify({ issues: [{ path: '$.x', message: 'wrong' }] }),
      });
      const result = await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
      );
      expect(result.ok).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.meta).toBeUndefined();
    });
  });

  describe('Part 1: configurable knobs', () => {
    it('uses default max_tokens 2000 (raised from 300) when no compoundConfig', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview({ foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract);
      const call = generateText.mock.calls[0][0];
      expect(call.max_tokens).toBe(2000);
    });

    it('uses default temperature 0.1 when no compoundConfig', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview({ foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract);
      const call = generateText.mock.calls[0][0];
      expect(call.temperature).toBe(0.1);
    });

    it('uses ir.model.id when no model override', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview({ foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract);
      const call = generateText.mock.calls[0][0];
      expect(call.model).toBe('omlx:mock');
    });

    it('per-gen max_tokens override applies', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
        undefined,
        { max_tokens: 4000 },
      );
      const call = generateText.mock.calls[0][0];
      expect(call.max_tokens).toBe(4000);
    });

    it('per-gen temperature override applies', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
        undefined,
        { temperature: 0.7 },
      );
      const call = generateText.mock.calls[0][0];
      expect(call.temperature).toBe(0.7);
    });

    it('per-gen model override applies (different model than main gen)', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
        undefined,
        { model: 'anthropic:claude-haiku-4-5-20251001' },
      );
      const call = generateText.mock.calls[0][0];
      expect(call.model).toBe('anthropic:claude-haiku-4-5-20251001');
    });

    it('all three overrides combine cleanly', async () => {
      const generateText = vi.fn().mockResolvedValue({ text: '{}' });
      await runReview(
        { foo: 'bar' }, minimalIr, {}, generateText as any, noopExtract,
        undefined,
        { max_tokens: 1500, temperature: 0.0, model: 'anthropic:claude-haiku-4-5-20251001' },
      );
      const call = generateText.mock.calls[0][0];
      expect(call.max_tokens).toBe(1500);
      expect(call.temperature).toBe(0.0);
      expect(call.model).toBe('anthropic:claude-haiku-4-5-20251001');
    });
  });
});
