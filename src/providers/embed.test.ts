import { describe, it, expect } from 'vitest';
import { mockEmbed, embedText, MOCK_DIM } from './embed.js';

describe('mockEmbed (RED-215 phase 5)', () => {
  it('produces a deterministic vector for the same input', () => {
    const a = mockEmbed('hello world', MOCK_DIM);
    const b = mockEmbed('hello world', MOCK_DIM);
    expect(a).toEqual(b);
    expect(a.length).toBe(MOCK_DIM);
  });

  it('produces different vectors for different inputs', () => {
    const a = mockEmbed('hello', MOCK_DIM);
    const b = mockEmbed('world', MOCK_DIM);
    // Cosine similarity should be well below 1 for clearly different inputs.
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < MOCK_DIM; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const cos = dot / Math.sqrt(na * nb);
    expect(Math.abs(cos)).toBeLessThan(0.5);
  });

  it('values are in roughly [-1, 1]', () => {
    const v = mockEmbed('sample', MOCK_DIM);
    for (let i = 0; i < v.length; i++) {
      expect(v[i]).toBeGreaterThanOrEqual(-1);
      expect(v[i]).toBeLessThanOrEqual(1);
    }
  });
});

describe('embedText (RED-215 phase 5)', () => {
  it('returns the deterministic mock vector when CAMBIUM_ALLOW_MOCK is set', async () => {
    const prev = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    try {
      const result = await embedText('omlx:bge-small-en', 'test');
      expect(result.dim).toBe(MOCK_DIM);
      expect(result.vector.length).toBe(MOCK_DIM);
      expect(result.model).toBe('omlx:bge-small-en');
      // Deterministic: same text yields same vector
      const again = await embedText('omlx:bge-small-en', 'test');
      expect(again.vector).toEqual(result.vector);
    } finally {
      if (prev === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
      else process.env.CAMBIUM_ALLOW_MOCK = prev;
    }
  });

  it('rejects a model id without a provider prefix (pre-RED-237 aliases unsupported)', async () => {
    const prev = process.env.CAMBIUM_ALLOW_MOCK;
    delete process.env.CAMBIUM_ALLOW_MOCK;
    try {
      await expect(embedText('bare-alias-name', 'text'))
        .rejects.toThrow(/no provider prefix/);
    } finally {
      if (prev !== undefined) process.env.CAMBIUM_ALLOW_MOCK = prev;
    }
  });

  it('rejects an unknown provider', async () => {
    const prev = process.env.CAMBIUM_ALLOW_MOCK;
    delete process.env.CAMBIUM_ALLOW_MOCK;
    try {
      await expect(embedText('gpt:text-embed', 'text'))
        .rejects.toThrow(/not supported/);
    } finally {
      if (prev !== undefined) process.env.CAMBIUM_ALLOW_MOCK = prev;
    }
  });
});
