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

/**
 * Why a completion stopped, normalized across providers (RED-174).
 *
 * Every provider reports this on the wire — Anthropic `stop_reason`,
 * OpenAI-compatible `choices[0].finish_reason`, Ollama `done_reason` — and
 * before RED-174 the runner discarded all of it. The cost was that hitting
 * `max_tokens` truncated the JSON mid-object and surfaced as a parse error,
 * which then fed the repair loop and re-truncated under the same ceiling.
 *
 *   - `length`   — the output ceiling was reached. The completion is a
 *                  fragment; nothing downstream should try to parse it.
 *   - `tool_use` — stopped to call a tool (agentic loop continues).
 *   - `stop`     — finished normally.
 *   - `other`    — reported something the mapping does not recognize.
 *
 * Optional: a custom provider that does not set it degrades to the
 * usage-vs-ceiling heuristic in the runner, not to the old parse error.
 */
export type StopReason = 'stop' | 'length' | 'tool_use' | 'other';

/**
 * Map a provider's native stop/finish/done reason onto `StopReason`.
 * Unknown non-empty values become `'other'`; absent stays `undefined` so
 * the runner can tell "provider said nothing" from "provider said stop".
 */
export function normalizeStopReason(raw: unknown): StopReason | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  switch (raw) {
    // Anthropic: max_tokens · OpenAI-compatible: length · Ollama: length
    case 'max_tokens':
    case 'length':
      return 'length';
    case 'tool_use':
    case 'tool_calls':
      return 'tool_use';
    case 'end_turn':
    case 'stop':
    case 'stop_sequence':
      return 'stop';
    default:
      return 'other';
  }
}

export type GenerateResult = {
  text: string;
  usage?: TokenUsage;
  /** RED-174. Absent when the provider reported nothing. */
  stopReason?: StopReason;
};

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
  /** RED-325: effort level for Anthropic models that dropped sampling params
   *  (Opus 4.7+, Fable 5, Mythos 5). Ignored by models that still accept
   *  `temperature` — the connector guards this. Optional; if absent, the
   *  model uses its own default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  /** RED-174. Absent when the provider reported nothing. */
  stopReason?: StopReason;
};

/** Options handed to a provider's `generateWithTools`. `model` is the
 *  prefix-stripped name (see `GenerateTextOpts`). */
export type GenerateWithToolsOpts = {
  model: string;
  messages: ProviderMessage[];
  tools: any[];
  max_tokens?: number;
  temperature?: number;
  /** RED-325: effort level for Anthropic models that dropped sampling params.
   *  See GenerateTextOpts.effort for full semantics. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  documents?: any[];
  modelOptions?: { disable_thinking?: boolean };
  /** #228: the cacheable head of the first user message. Identical contract
   *  to `GenerateTextOpts.cachedPrefix` — providers without
   *  `supportsPromptCacheControl` never see it, because the runner folds it
   *  back into that message before dispatch. */
  cachedPrefix?: string;
};

// #275 DEC-006: mode :decision. A Jev-style provider answers a set of typed
// questions per call — a "choice" (String + `enum:`) or a "boolean" (Boolean)
// — with a probability distribution and (for choice) a calibrated
// confidence. This is a PARALLEL request/response shape to
// GenerateTextOpts/GenerateResult, not an extension of it: normalizing a
// typed question set into a prompt + jsonSchema would let a text-generating
// provider silently "work" in decision mode with no probabilities — a
// silent downgrade `decide` exists to avoid.
export type DecisionQuestion =
  | { kind: 'choice'; instructions: string; options: Record<string, string | null> }
  | { kind: 'boolean'; instructions: string };

/** Options handed to a provider's `decide`. NOTE: `model`, like
 *  `GenerateTextOpts.model`, is the model NAME with the provider prefix
 *  already stripped. `state` is the nested JSON object the runner assembles
 *  (`{ system?, task, context }`) — opaque to the provider from here on. */
export type DecideOpts = {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
};

// #275 DEC-009b: `confidence` on a choice answer is optional. The vendor
// shows it in every documented example but does not guarantee it in
// writing (RESEARCH-275) — a required field over an undocumented
// guarantee is an outage bet the runner no longer takes. Omit the key
// when your provider has no confidence to report; never synthesize one.
export type DecideAnswer =
  | { kind: 'choice'; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { kind: 'boolean'; probability: number };

/**
 * What `decide()` must return — checked by the runner
 * (`handleDecisionGenerate`, step-handlers.ts) AFTER the call has already
 * returned successfully (#275 DEC-009b). See `N - Model Identifiers` §
 * `decide` for the worked example; the rules, briefly:
 *
 * - `answers` MUST have one entry per question in `DecideOpts.questions`,
 *   keyed by the same field name.
 * - A `choice` answer's `choice` MUST be a string; AJV (not this
 *   contract) is the judge of whether it's one of the declared options.
 * - A `boolean` answer's `probability` MUST be a number.
 * - `confidence` on a choice answer is OPTIONAL (see `DecideAnswer`) —
 *   omit it, don't null it or synthesize one.
 * - `probability`, `confidence` (when present), and each DECLARED
 *   option's `probabilities` value MUST be finite (no `NaN`/`Infinity`).
 *   An undeclared `probabilities` key is unchecked — no schema constrains
 *   it, so pass through whatever the vendor sends.
 * - `usage`, when present, is best-effort: a partial or non-finite
 *   `usage` is silently dropped (no throw, no budget accounting for that
 *   call) rather than failing the run.
 *
 * A violation of the first four rules produces a `Generate { ok: false }`
 * trace row, not a throw — the run falls through the normal decision-mode
 * validation tail instead of escaping `runGen`. Only `decide()` itself
 * throwing (a transport/provider error) still propagates unhandled.
 */
export type DecideResult = {
  answers: Record<string, DecideAnswer>;
  usage?: TokenUsage;
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
   *  prompt-cache breakpoint. When true, the runner forwards **both**
   *  `GenerateTextOpts.cachedPrefix` *and* `GenerateWithToolsOpts.cachedPrefix`
   *  to the provider unchanged. When false (or absent), the runner folds
   *  `cachedPrefix` back in before dispatch — into `prompt` on the
   *  single-turn path, into the FIRST user message on the agentic path —
   *  so the provider always sees a single combined string and the caller's
   *  grounded prompts retain their pre-split ordering.
   *
   *  **The agentic half of that contract is new as of this release (#228,
   *  DEC-009).** This flag previously gated `GenerateTextOpts.cachedPrefix`
   *  only. A custom provider that sets it and consumes `cachedPrefix` in
   *  `generateText` but NOT in `generateWithTools` will silently drop the
   *  prefix — the whole document and context payload — on every agentic
   *  run: no error, no trace signal. If you set this flag, consume
   *  `cachedPrefix` in both methods. See `COMPATIBILITY.md` § Behavior
   *  register. */
  supportsPromptCacheControl?: boolean;
  /** Optional context appended to the thrown error when a fetch to this
   *  provider fails (the "check CAMBIUM_OMLX_BASEURL…" hint). */
  fetchFailureHint?: string;
  generateText(opts: GenerateTextOpts): Promise<GenerateResult>;
  generateWithTools(
    opts: GenerateWithToolsOpts,
  ): Promise<GenerateWithToolsResult>;
  /** #275 DEC-006: optional. Absent means this provider cannot serve
   *  `mode :decision` gens — `makeDecide` (runner.ts) throws a plain Error
   *  naming the model prefix rather than falling back to `generateText`.
   *  `model` is prefix-stripped, like the other methods. */
  decide?(opts: DecideOpts): Promise<DecideResult>;
}
