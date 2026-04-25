import { createHash } from 'node:crypto';
import { validateProviderBaseUrl } from './base-url-validator.js';

/**
 * RED-215 phase 5: embedding provider — vectorize a string using
 * oMLX (OpenAI-compatible) or Ollama. Mirrors the generateText shape
 * in runner.ts: parse the `provider:name` model id, call the right
 * endpoint, return a Float32Array.
 *
 * Under CAMBIUM_ALLOW_MOCK=1 the function short-circuits to a
 * deterministic SHA-256-seeded vector so integration tests can assert
 * nearest-neighbor behaviour without a real embedding backend. Two
 * runs with the same text get the same vector; different text gets
 * different vectors. Dim defaults to 384 (matches BGE small, which
 * we use as the workspace default).
 *
 * Threat model: this module uses bare `fetch` against the URL in
 * CAMBIUM_OMLX_BASEURL / CAMBIUM_OLLAMA_BASEURL — same as generateText
 * in runner.ts. Embedding calls are FRAMEWORK INFRASTRUCTURE, not tool
 * egress from inside a gen sandbox, so they do not go through
 * guardedFetch. An attacker who can set these env vars can redirect
 * embedding traffic anywhere — exactly the same trust boundary as the
 * model inference endpoints. This is intentional and documented; do
 * not "fix" it by wiring embedText through ctx.fetch.
 */

export const MOCK_DIM = 384;

export type EmbedResult = {
  vector: Float32Array;
  dim: number;
  model: string;
};

/** Parse `omlx:bge-small-en` → { provider: 'omlx', name: 'bge-small-en' }. */
function parseModelId(modelId: string): { provider: string; name: string } {
  const m = modelId.match(/^([a-zA-Z0-9_-]+):(.*)$/);
  if (!m) {
    throw new Error(
      `memory embed model '${modelId}' has no provider prefix. ` +
        "Use 'omlx:<name>' or 'ollama:<name>'. Bare alias names are not yet " +
        'supported (coordinated with RED-237 — file a ticket reference if you expected an alias).',
    );
  }
  return { provider: m[1], name: m[2] };
}

/**
 * Embed `text` with the given `model` id. Async; always returns a
 * fresh Float32Array. The returned `dim` is the vector length — the
 * caller pins it into the bucket's `meta` table on first write so
 * later runs can detect model changes.
 */
export async function embedText(model: string, text: string): Promise<EmbedResult> {
  if (process.env.CAMBIUM_ALLOW_MOCK === '1') {
    return { vector: mockEmbed(text, MOCK_DIM), dim: MOCK_DIM, model };
  }

  const { provider, name } = parseModelId(model);

  if (provider === 'omlx') {
    const base = process.env.CAMBIUM_OMLX_BASEURL ?? 'http://localhost:8080';
    validateProviderBaseUrl('oMLX embed (CAMBIUM_OMLX_BASEURL)', base);
    const apiKey = process.env.CAMBIUM_OMLX_API_KEY;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: name, input: text }),
    });
    if (!res.ok) throw new Error(`oMLX embed error: HTTP ${res.status}`);
    const json: any = await res.json();
    const rawVec = json?.data?.[0]?.embedding;
    if (!Array.isArray(rawVec)) throw new Error('oMLX embed: missing data[0].embedding');
    const vec = Float32Array.from(rawVec);
    return { vector: vec, dim: vec.length, model };
  }

  if (provider === 'ollama') {
    const base = process.env.CAMBIUM_OLLAMA_BASEURL ?? 'http://localhost:11434';
    validateProviderBaseUrl('Ollama embed (CAMBIUM_OLLAMA_BASEURL)', base);
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed error: HTTP ${res.status}`);
    const json: any = await res.json();
    // Newer Ollama: { embeddings: [[floats]] }; legacy: { embedding: [floats] }
    const rawVec = json?.embeddings?.[0] ?? json?.embedding;
    if (!Array.isArray(rawVec)) throw new Error('Ollama embed: missing embeddings/embedding');
    const vec = Float32Array.from(rawVec);
    return { vector: vec, dim: vec.length, model };
  }

  throw new Error(
    `memory embed provider '${provider}' is not supported. Use 'omlx:<name>' or 'ollama:<name>'.`,
  );
}

/**
 * Deterministic mock embedding: SHA-256 of the input seeds a simple
 * xorshift PRNG that fills a `dim`-length Float32Array in [-1, 1].
 * Same input → same vector; different input → different vector. The
 * distribution is not realistic (not unit-normalized, not clustered
 * by meaning), but nearest-neighbour by content equality still works
 * so sliding-window-style assertions hold in tests.
 */
export function mockEmbed(text: string, dim: number): Float32Array {
  const seed = createHash('sha256').update(text).digest();
  // Seed an xorshift32 from the first 4 bytes of the hash.
  let state = seed.readUInt32LE(0) || 0x9E3779B1;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0; // keep unsigned
    // Map uint32 → [-1, 1]
    out[i] = (state / 0xFFFFFFFF) * 2 - 1;
  }
  return out;
}
