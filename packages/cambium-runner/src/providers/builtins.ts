// RED-393 phase 2: framework built-in providers.
//
// The three providers Cambium ships with — expressed as `CambiumProvider`s so
// the runner dispatches them through the same registry path app providers use.
// `omlx` and `anthropic` dogfood the Tier-1 factories; `ollama` is bespoke
// (`defineProvider`) because its API isn't OpenAI-shaped — two distinct
// endpoints (`/api/generate` for text, `/api/chat` for tools) and a
// non-standard usage field.
//
// Zero new dependencies: every provider is raw `fetch`.

import { ProviderRegistry, defineProvider } from './registry.js';
import { openaiCompatible, anthropicCompatible } from './factories.js';
import { ProviderHttpError, ProviderConnectionError } from './types.js';
import { normalizeOmlxBaseUrl, validateProviderBaseUrl } from './base-url-validator.js';
import { buildOllamaChatRequest, normalizeOllamaChatResponse } from './ollama.js';

/** oMLX server (OpenAI-compatible), with the vLLM/Qwen quirks the bare
 *  OpenAI shape doesn't need. */
export const omlxProvider = openaiCompatible({
  name: 'omlx',
  supportsDocuments: false,
  errorLabel: 'oMLX',
  fetchFailureHint:
    'oMLX fetch failed. Check CAMBIUM_OMLX_BASEURL (default http://localhost:8080) and server status.',
  baseUrl: () => {
    const b = normalizeOmlxBaseUrl(process.env.CAMBIUM_OMLX_BASEURL ?? 'http://localhost:8080');
    validateProviderBaseUrl('oMLX (CAMBIUM_OMLX_BASEURL)', b);
    return b;
  },
  auth: () => process.env.CAMBIUM_OMLX_API_KEY,
  thinkingSuppression: true,
  structuredOutputs: () => (process.env.CAMBIUM_OMLX_STRUCTURED_OUTPUTS ?? '1') === '1',
  responseFormat: () => (process.env.CAMBIUM_OMLX_RESPONSE_FORMAT ?? '0') === '1',
  reasoningContentFallback: true,
  surfaceErrorBody: true,
});

/** Anthropic Messages API. Native document input supported; prompt caching on
 *  by default via the builder. */
export const anthropicProvider = anthropicCompatible({
  name: 'anthropic',
  supportsDocuments: true,
  errorLabel: 'Anthropic',
  fetchFailureHint:
    'Anthropic fetch failed. Check ANTHROPIC_API_KEY and network reachability to api.anthropic.com.',
  baseUrl: () => {
    const b = process.env.CAMBIUM_ANTHROPIC_BASEURL ?? 'https://api.anthropic.com';
    validateProviderBaseUrl('Anthropic (CAMBIUM_ANTHROPIC_BASEURL)', b);
    return b;
  },
  apiKey: () => process.env.CAMBIUM_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  missingKeyMessage: 'Anthropic: ANTHROPIC_API_KEY (or CAMBIUM_ANTHROPIC_API_KEY) is required.',
});

/** Ollama — bespoke because the API isn't OpenAI-shaped. */
export const ollamaProvider = defineProvider({
  name: 'ollama',
  supportsDocuments: false,
  fetchFailureHint: 'Ollama fetch failed. Start Ollama (`ollama serve`).',

  async generateText(opts) {
    // NOTE: the text endpoint is hardcoded to localhost (no env override),
    // preserving pre-RED-393 behavior; only the tool path reads
    // CAMBIUM_OLLAMA_BASEURL.
    const body = {
      model: opts.model,
      prompt: `${opts.system}\n\n${opts.prompt}`,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_predict: opts.max_tokens ?? 1200,
      },
    };
    let res: Response;
    try {
      res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      throw new ProviderConnectionError(
        `Ollama connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
      );
    }
    if (!res.ok) throw new ProviderHttpError(res.status, `Ollama error: HTTP ${res.status}`);
    const json: any = await res.json();
    return {
      text: json.response as string,
      usage:
        json.prompt_eval_count != null
          ? {
              prompt_tokens: json.prompt_eval_count ?? 0,
              completion_tokens: json.eval_count ?? 0,
              total_tokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0),
            }
          : undefined,
    };
  },

  async generateWithTools(opts) {
    // RED-208: Ollama's /api/chat accepts OpenAI-format tools. Request/response
    // shaping lives in ./ollama.js so it's unit-testable without a live server.
    const baseUrl = process.env.CAMBIUM_OLLAMA_BASEURL ?? 'http://localhost:11434';
    validateProviderBaseUrl('Ollama (CAMBIUM_OLLAMA_BASEURL)', baseUrl);
    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = buildOllamaChatRequest({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      throw new ProviderConnectionError(
        `Ollama connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
      );
    }
    if (!res.ok) throw new ProviderHttpError(res.status, `Ollama error: HTTP ${res.status}`);
    const json: any = await res.json();
    const normalized = normalizeOllamaChatResponse(json);
    // Inline tool-call markup parsing is applied by the dispatcher.
    return {
      message: { content: normalized.message.content, tool_calls: normalized.message.tool_calls },
      usage: normalized.usage,
    };
  },
});

/**
 * Build a registry pre-loaded with the framework built-ins. Register order
 * doesn't matter among built-ins (distinct names); app providers register
 * AFTER these in phase 3 so a same-named app provider shadows the built-in.
 */
export function buildBuiltinRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(anthropicProvider);
  reg.register(omlxProvider);
  reg.register(ollamaProvider);
  return reg;
}
