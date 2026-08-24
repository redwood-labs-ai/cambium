/**
 * RED-208: Ollama tool-use provider.
 *
 * Builds /api/chat requests with tools and normalizes the response into the
 * same shape the oMLX path produces (`GenerateWithToolsResult`). Runner
 * wires these helpers with fetch + error handling; this module is pure so
 * it's unit-testable without network.
 *
 * Ollama's API differs from OpenAI/oMLX in three ways the runner cares about:
 *   1. Endpoint is /api/chat, not /v1/chat/completions.
 *   2. Response shape is { message: {...} }, not { choices: [{ message: {...} }] }.
 *   3. tool_calls arrive with `function.arguments` as an object (not a stringified
 *      JSON). Call IDs are not provided — we synthesize them so the downstream
 *      tool_call_id contract holds.
 *   4. Token usage is prompt_eval_count / eval_count, not usage.{prompt,completion,total}_tokens.
 *   5. Request messages mirror #3: replayed assistant tool_calls must carry
 *      `function.arguments` as an object too — the runner's internal string
 *      form (OpenAI convention) is rejected with HTTP 400 on continuation turns (#153).
 */

type Message = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type OllamaChatResult = {
  /** RED-174: Ollama's raw `done_reason` ("length" when num_predict caps
   *  the output). Passed through unmapped — this module stays
   *  dependency-free, so `normalizeStopReason` is applied by the caller in
   *  builtins.ts where the provider object is assembled. */
  doneReason?: string;
  message: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  usage?: TokenUsage;
};

export type OllamaChatRequestOpts = {
  model: string;           // just the model name, no "ollama:" prefix
  messages: Message[];
  tools: any[];            // OpenAI-format tool definitions
  max_tokens?: number;
  temperature?: number;
};

/** Parse a stringified tool-call payload into an object (see #153). */
function parseArgsObject(raw: string): unknown {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    // Empty or malformed payload — {} keeps the request valid.
    return {};
  }
}

/**
 * Convert assistant tool_calls to /api/chat shape (#153). The runner's internal
 * canonical form carries `function.arguments` as a JSON string (OpenAI convention);
 * Ollama rejects that with HTTP 400 on continuation turns, so parse it back to an
 * object before sending. Non-string values pass through untouched.
 */
export function toOllamaToolCalls(toolCalls?: any[]): any[] | undefined {
  if (!toolCalls) return toolCalls;
  return toolCalls.map((tc: any) => {
    const fn = tc?.function ?? {};
    const args = typeof fn.arguments === 'string' ? parseArgsObject(fn.arguments) : fn.arguments;
    return { ...tc, function: { ...fn, arguments: args } };
  });
}

/** Build the request body for Ollama's /api/chat endpoint. */
export function buildOllamaChatRequest(opts: OllamaChatRequestOpts): Record<string, any> {
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages.map((m) =>
      m.tool_calls ? { ...m, tool_calls: toOllamaToolCalls(m.tool_calls) } : m,
    ),
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.max_tokens ?? 1200,
    },
  };
  if (opts.tools.length > 0) {
    body.tools = opts.tools;
  }
  // Ollama doesn't support tool_choice: 'none'; when tools are omitted entirely
  // the model simply produces content. That's the same end state as oMLX's
  // explicit disable-path.
  return body;
}

/**
 * Normalize Ollama's /api/chat response into the shape the runner expects.
 * Synthesizes a tool_call id (Ollama omits it) and stringifies function.arguments
 * (Ollama returns it as an object; the dispatch code JSON.parses a string).
 */
export function normalizeOllamaChatResponse(json: any): OllamaChatResult {
  const msg = json?.message;
  if (!msg) throw new Error('Ollama: missing message in response');

  const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;

  const toolCalls = rawToolCalls?.map((tc: any, i: number) => {
    const fn = tc?.function ?? {};
    const args = fn.arguments;
    return {
      id: tc.id ?? `call_ollama_${i}_${fn.name ?? 'tool'}`,
      type: 'function' as const,
      function: {
        name: fn.name ?? '',
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    };
  });

  const promptTokens = Number(json?.prompt_eval_count ?? 0);
  const completionTokens = Number(json?.eval_count ?? 0);
  const usage: TokenUsage | undefined = (promptTokens || completionTokens)
    ? {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      }
    : undefined;

  return {
    message: {
      content: msg.content ?? null,
      tool_calls: toolCalls,
    },
    usage,
    // RED-174: preserved through the chat path too, not just /api/generate.
    doneReason: typeof json?.done_reason === 'string' ? json.done_reason : undefined,
  };
}
