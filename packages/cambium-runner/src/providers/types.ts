// RED-393: provider-registry types. The runner dispatches model calls
// through a registry of `CambiumProvider`s keyed by the model-id prefix
// (`anthropic:`, `omlx:`, `ollama:`, or any app-supplied prefix).
//
// Cross-cutting concerns (mock short-circuit, native-document gate,
// fetch-failure hinting) stay in the registry dispatcher in runner.ts;
// a provider implements ONLY its raw API call (build → fetch → normalize).
// That keeps app-supplied providers thin and guarantees they inherit the
// gates rather than each re-implementing them.

import type { ToolCallMessage } from '../inline-tool-calls.js';

export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

// RED-421 (DEC-A): typed provider HTTP error. Built-in providers throw this
// on an HTTP-status error so the fallback classifier reads a typed integer
// instead of regex-sniffing the message string. Part of the provider-author
// contract — a custom provider that wants retry-on-transient throws this with
// the HTTP status; a plain `Error` is classified deterministic (fail fast,
// no fan-out). Exported from the package root. Keep minimal: do not add fields.
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

// RED-421 (DEC-D): typed connection error. Built-in providers wrap a
// fetch-level rejection (ECONNREFUSED / DNS / TLS — no HTTP response received)
// in this subclass so the fallback classifier treats it as transient.
// `status` is hardcoded to 0 (the sentinel for "no HTTP status"), which
// `isTransientStatus(0)` recognises. Custom providers that throw a plain
// `Error` or `TypeError` still hit the deterministic path — DEC-A's fan-out
// protection is unchanged. Exported from the package root alongside
// `ProviderHttpError`. Keep minimal: constructor takes only `message`.
export class ProviderConnectionError extends ProviderHttpError {
  constructor(message: string) {
    super(0, message);
    this.name = 'ProviderConnectionError';
  }
}

export type GenerateResult = { text: string; usage?: TokenUsage };

export type ProviderMessage = {
  role: string;
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

/** Options handed to a provider's `generateText`. NOTE: `model` is the model
 *  NAME with the provider prefix already stripped (e.g. `"claude-sonnet-4-6"`,
 *  not `"anthropic:claude-sonnet-4-6"`). The provider applies its own
 *  `modelName` transform to produce the wire id. */
export type GenerateTextOpts = {
  model: string;
  system: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  jsonSchema?: any;
  documents?: any[];
  modelOptions?: { disable_thinking?: boolean };
  /** Long shared payload eligible for the provider's prompt-cache prefix.
   *  When set, `prompt` is the per-call instruction and the provider emits
   *  `cachedPrefix` first (as a separate block with a cache breakpoint)
   *  followed by `prompt`. Providers that lack cache support never see
   *  this field — the runner concatenates it into `prompt` upstream
   *  (`<prompt>\n\n<cachedPrefix>`, preserving pre-existing grounded
   *  ordering) so dispatch stays uniform. */
  cachedPrefix?: string;
};

export type GenerateWithToolsResult = {
  message: { content: string | null; tool_calls?: ToolCallMessage[] };
  usage?: TokenUsage;
};

/** Options handed to a provider's `generateWithTools`. `model` is the
 *  prefix-stripped name (see `GenerateTextOpts`). */
export type GenerateWithToolsOpts = {
  model: string;
  messages: ProviderMessage[];
  tools: any[];
  max_tokens?: number;
  temperature?: number;
  documents?: any[];
  modelOptions?: { disable_thinking?: boolean };
};

export interface CambiumProvider {
  /** Registry key = the model-id prefix. `anthropic:claude-...` →
   *  `registry.get("anthropic")`. For app providers this derives from the
   *  filename (`app/providers/openrouter.ts` → `"openrouter"`). */
  name: string;
  /** Whether this provider accepts native document input (base64 PDF/image
   *  envelopes). The registry dispatcher uses it for the fail-fast gate so a
   *  document never gets silently JSON-stringified into a prompt. */
  supportsDocuments: boolean;
  /** Whether this provider can mark a portion of the user prompt with a
   *  prompt-cache breakpoint. When true, the runner forwards
   *  `GenerateTextOpts.cachedPrefix` to the provider unchanged. When false
   *  (or absent), the runner concatenates `cachedPrefix` into `prompt`
   *  before dispatch so the provider sees a single combined string and the
   *  caller's grounded prompts retain their pre-split ordering. */
  supportsPromptCacheControl?: boolean;
  /** Optional context appended to the thrown error when a fetch to this
   *  provider fails (the "check CAMBIUM_OMLX_BASEURL…" hint). */
  fetchFailureHint?: string;
  generateText(opts: GenerateTextOpts): Promise<GenerateResult>;
  generateWithTools(opts: GenerateWithToolsOpts): Promise<GenerateWithToolsResult>;
}
