// RED-393 phase 2: Tier-1 authoring factories.
//
// Most providers are "an OpenAI-compatible (or Anthropic-compatible) HTTP
// endpoint at a different base URL with a different auth header." These two
// factories compose the framework's existing request-build / fetch /
// normalize logic into a full `CambiumProvider` from ~4 lines of config, so
// app authors don't re-implement the wire protocol.
//
//   export default openaiCompatible({
//     name: 'openrouter',
//     baseUrl: 'https://openrouter.ai/api',
//     auth: () => process.env.OPENROUTER_API_KEY,
//   })
//
// The built-in `omlx` and `anthropic` providers are themselves built via
// these factories (dogfood) — oMLX passes the extra quirk knobs
// (thinking-suppression, structured-output gates, reasoning_content
// fallback, upstream-error-body surfacing) that a vanilla OpenAI endpoint
// doesn't need; the defaults give a clean OpenAI gateway.

import type {
  CambiumProvider,
  GenerateResult,
  GenerateTextOpts,
  GenerateWithToolsOpts,
  GenerateWithToolsResult,
} from './types.js';
import { ProviderHttpError, ProviderConnectionError } from './types.js';
import { normalizeModelName, type ModelNameTransform } from './registry.js';
import {
  buildAnthropicMessagesRequest,
  normalizeAnthropicMessagesResponse,
} from './anthropic.js';

function mapOpenAIUsage(usage: any): GenerateResult['usage'] {
  return usage
    ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      }
    : undefined;
}

export type OpenAICompatibleConfig = {
  /** Registry key = model-id prefix. */
  name: string;
  /** Native document input support. Generic OpenAI endpoints can't take
   *  base64 PDF/image envelopes, so this defaults to false. */
  supportsDocuments?: boolean;
  /** Appended to fetch-failure errors by the registry dispatcher. */
  fetchFailureHint?: string;
  /** Base URL (string or env-resolving callback). The callback is the place
   *  to normalize + validate (SSRF guard) — the factory calls it verbatim. */
  baseUrl: string | (() => string);
  /** Bearer-token callback. Secrets resolve from env at call time; returning
   *  undefined sends no Authorization header (some local servers need none). */
  auth?: () => string | undefined;
  /** Cambium model name → wire id transform (Azure-deployment sugar etc).
   *  Identity by default. */
  modelName?: ModelNameTransform;
  /** Label used in HTTP-error messages ("<label> error: HTTP 500"). Defaults
   *  to `name`. */
  errorLabel?: string;
  // --- quirk knobs (off by default → vanilla OpenAI behavior) ---
  /** When the resolved `disable_thinking` is true, inject `/no_think` into the
   *  prompts and send `chat_template_kwargs: { enable_thinking: false }`
   *  (Qwen-on-vLLM thinking suppression). */
  thinkingSuppression?: boolean;
  /** Gate for vLLM `extra_body.structured_outputs` when a jsonSchema is set. */
  structuredOutputs?: () => boolean;
  /** Gate for OpenAI-style `response_format` when a jsonSchema is set. */
  responseFormat?: () => boolean;
  /** Fall back to `message.reasoning_content` when `content` is empty (thinking
   *  models that leak the final answer into the reasoning channel). */
  reasoningContentFallback?: boolean;
  /** Include up to 1.5 KB of the upstream response body in HTTP-error
   *  messages. Safe for server-internal endpoints (oMLX/vLLM); leave off for
   *  endpoints whose error bodies may echo credentials. */
  surfaceErrorBody?: boolean;
};

/**
 * Build a full `CambiumProvider` for an OpenAI-compatible chat-completions
 * endpoint (`POST {baseUrl}/v1/chat/completions`).
 */
export function openaiCompatible(config: OpenAICompatibleConfig): CambiumProvider {
  const toWire = normalizeModelName(config.modelName);
  const errorLabel = config.errorLabel ?? config.name;
  const resolveBaseUrl = () =>
    typeof config.baseUrl === 'function' ? config.baseUrl() : config.baseUrl;

  const authHeaders = (): Record<string, string> => {
    const token = config.auth?.();
    return token ? { authorization: `Bearer ${token}` } : {};
  };

  const url = () => `${resolveBaseUrl().replace(/\/$/, '')}/v1/chat/completions`;

  const errBodyOf = async (res: Response): Promise<string> =>
    config.surfaceErrorBody ? (await res.text().catch(() => '')).slice(0, 1500) : '';

  return {
    name: config.name,
    supportsDocuments: config.supportsDocuments ?? false,
    fetchFailureHint: config.fetchFailureHint,

    async generateText(opts: GenerateTextOpts): Promise<GenerateResult> {
      const disableThinking = config.thinkingSuppression && !!opts.modelOptions?.disable_thinking;
      const systemContent = disableThinking ? `/no_think\n${opts.system}` : opts.system;
      const userContent = disableThinking ? `${opts.prompt}\n/no_think` : opts.prompt;

      const body: any = {
        model: toWire(opts.model),
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1200,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
      };
      if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };
      if (opts.jsonSchema && config.structuredOutputs?.()) {
        body.extra_body = { structured_outputs: { json: opts.jsonSchema } };
      }
      if (opts.jsonSchema && config.responseFormat?.()) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.jsonSchema?.$id ?? 'Schema', schema: opts.jsonSchema },
        };
      }

      const target = url();
      const reqHeaders = { 'content-type': 'application/json', ...authHeaders() };
      let res: Response;
      try {
        res = await fetch(target, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(body),
        });
      } catch (fetchErr) {
        throw new ProviderConnectionError(
          `${errorLabel} connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
        );
      }
      if (!res.ok) {
        const errBody = await errBodyOf(res);
        throw new ProviderHttpError(res.status, `${errorLabel} error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ''}`);
      }
      const json: any = await res.json();
      const message = json?.choices?.[0]?.message;
      let content = message?.content;
      if (!content && config.reasoningContentFallback && typeof message?.reasoning_content === 'string') {
        process.stderr.write(
          `[cambium] ${errorLabel}: empty content but reasoning_content present (${message.reasoning_content.length} chars). ` +
          `Falling back to reasoning_content. Consider \`model "<id>", disable_thinking: true\` to address at the source.\n`,
        );
        content = message.reasoning_content;
      }
      if (!content) {
        const bodyPreview = JSON.stringify(json).slice(0, 1500);
        throw new Error(`${errorLabel}: missing choices[0].message.content — ${bodyPreview}`);
      }
      return { text: content as string, usage: mapOpenAIUsage(json?.usage) };
    },

    async generateWithTools(opts: GenerateWithToolsOpts): Promise<GenerateWithToolsResult> {
      const disableThinking = config.thinkingSuppression && !!opts.modelOptions?.disable_thinking;

      let messages = opts.messages;
      if (disableThinking) {
        const lastUser = opts.messages.findLastIndex((m) => m.role === 'user');
        const firstSystem = opts.messages.findIndex((m) => m.role === 'system');
        messages = opts.messages.map((m, i) => {
          if (m.role === 'user' && i === lastUser) {
            return { ...m, content: (m.content ?? '') + '\n/no_think' };
          }
          if (m.role === 'system' && i === firstSystem) {
            return { ...m, content: `/no_think\n${m.content ?? ''}` };
          }
          return m;
        });
      }

      const body: any = {
        model: toWire(opts.model),
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1200,
        messages,
      };
      if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };
      if (opts.tools.length > 0) {
        body.tools = opts.tools;
      } else {
        // The model has seen tools in earlier turns and will keep calling them
        // unless explicitly told not to.
        body.tool_choice = 'none';
      }

      const target = url();
      const reqHeaders = { 'content-type': 'application/json', ...authHeaders() };
      let res: Response;
      try {
        res = await fetch(target, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(body),
        });
      } catch (fetchErr) {
        throw new ProviderConnectionError(
          `${errorLabel} connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
        );
      }
      if (!res.ok) {
        const errBody = await errBodyOf(res);
        throw new ProviderHttpError(res.status, `${errorLabel} error: HTTP ${res.status}${errBody ? ` — ${errBody}` : ''}`);
      }
      const json: any = await res.json();
      const msg = json?.choices?.[0]?.message;
      if (!msg) {
        const bodyPreview = JSON.stringify(json).slice(0, 1500);
        throw new Error(`${errorLabel}: missing choices[0].message — ${bodyPreview}`);
      }

      let content = msg.content ?? null;
      if (!content && config.reasoningContentFallback && typeof msg.reasoning_content === 'string') {
        process.stderr.write(
          `[cambium] ${errorLabel} (agentic): empty content but reasoning_content present (${msg.reasoning_content.length} chars). ` +
          `Falling back to reasoning_content.\n`,
        );
        content = msg.reasoning_content;
      }

      // NOTE: inline tool-call markup parsing (parseInlineToolCalls) is applied
      // by the registry dispatcher uniformly across all providers — not here.
      return {
        message: { content, tool_calls: msg.tool_calls ?? undefined },
        usage: mapOpenAIUsage(json?.usage),
      };
    },
  };
}

export type AnthropicCompatibleConfig = {
  name: string;
  supportsDocuments?: boolean;
  fetchFailureHint?: string;
  /** Base URL (string or callback). Callback normalizes + validates. */
  baseUrl: string | (() => string);
  /** API key callback (`x-api-key` header). Returning undefined trips the
   *  missing-key error below. */
  apiKey: () => string | undefined;
  /** Error thrown when `apiKey()` returns undefined. */
  missingKeyMessage?: string;
  /** `anthropic-version` header. Defaults to the pinned framework value. */
  anthropicVersion?: string;
  modelName?: ModelNameTransform;
  errorLabel?: string;
  /** Apply provider-level prompt caching (system block + last tool + last
   *  document). Default true. */
  cache?: boolean;
};

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Build a full `CambiumProvider` for an Anthropic-Messages-compatible endpoint
 * (`POST {baseUrl}/v1/messages`). HTTP-error messages deliberately omit the
 * upstream body — Anthropic 401/403 bodies can echo credential fragments.
 */
export function anthropicCompatible(config: AnthropicCompatibleConfig): CambiumProvider {
  const toWire = normalizeModelName(config.modelName);
  const errorLabel = config.errorLabel ?? config.name;
  const version = config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  const resolveBaseUrl = () =>
    typeof config.baseUrl === 'function' ? config.baseUrl() : config.baseUrl;
  const url = () => `${resolveBaseUrl().replace(/\/$/, '')}/v1/messages`;

  const headers = (): Record<string, string> => {
    const key = config.apiKey();
    if (!key) {
      throw new Error(config.missingKeyMessage ?? `${errorLabel}: API key is required.`);
    }
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': version,
    };
  };

  return {
    name: config.name,
    supportsDocuments: config.supportsDocuments ?? false,
    fetchFailureHint: config.fetchFailureHint,

    async generateText(opts: GenerateTextOpts): Promise<GenerateResult> {
      const body = buildAnthropicMessagesRequest({
        model: toWire(opts.model),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
        cache: config.cache,
        documents: opts.documents ?? [],
      });
      const target = url();
      const h = headers();
      let res: Response;
      try {
        res = await fetch(target, { method: 'POST', headers: h, body: JSON.stringify(body) });
      } catch (fetchErr) {
        throw new ProviderConnectionError(
          `${errorLabel} connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
        );
      }
      if (!res.ok) throw new ProviderHttpError(res.status, `${errorLabel} error: HTTP ${res.status}`);
      const json: any = await res.json();
      const normalized = normalizeAnthropicMessagesResponse(json);
      return { text: normalized.message.content ?? '', usage: normalized.usage };
    },

    async generateWithTools(opts: GenerateWithToolsOpts): Promise<GenerateWithToolsResult> {
      const body = buildAnthropicMessagesRequest({
        model: toWire(opts.model),
        messages: opts.messages,
        tools: opts.tools,
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
        cache: config.cache,
        documents: opts.documents ?? [],
      });
      const target = url();
      const h = headers();
      let res: Response;
      try {
        res = await fetch(target, { method: 'POST', headers: h, body: JSON.stringify(body) });
      } catch (fetchErr) {
        throw new ProviderConnectionError(
          `${errorLabel} connection failed: ${(fetchErr as Error).message ?? String(fetchErr)}`,
        );
      }
      if (!res.ok) throw new ProviderHttpError(res.status, `${errorLabel} error: HTTP ${res.status}`);
      const json: any = await res.json();
      const normalized = normalizeAnthropicMessagesResponse(json);
      // Inline tool-call markup parsing is applied by the dispatcher.
      return {
        message: { content: normalized.message.content, tool_calls: normalized.message.tool_calls },
        usage: normalized.usage,
      };
    },
  };
}
