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
  /** Optional context appended to the thrown error when a fetch to this
   *  provider fails (the "check CAMBIUM_OMLX_BASEURL…" hint). */
  fetchFailureHint?: string;
  generateText(opts: GenerateTextOpts): Promise<GenerateResult>;
  generateWithTools(opts: GenerateWithToolsOpts): Promise<GenerateWithToolsResult>;
}
