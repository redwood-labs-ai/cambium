/**
 * RED-321: Anthropic Messages API provider.
 *
 * Builds /v1/messages requests and normalizes responses into the same shape
 * the oMLX/Ollama paths produce. Runner wires these helpers with fetch +
 * error handling; this module is pure so it's unit-testable without network.
 *
 * Anthropic's API differs from OpenAI/oMLX in four ways the runner cares about:
 *   1. System prompt is top-level `system`, not a message role.
 *   2. Assistant output is a `content[]` array of typed blocks — `text` blocks
 *      for prose, `tool_use` blocks for function calls. We flatten text blocks
 *      into a single string and translate tool_use → the runner's ToolCallMessage.
 *   3. Tool results go back as a user message with `content: [{type:'tool_result',
 *      tool_use_id, content}]`, not `{role:'tool', tool_call_id, content}`.
 *   4. Prompt caching — opt-in per-block via `cache_control: {type:'ephemeral'}`.
 *      We enable it by default on the system block and the last tool (which
 *      caches the whole tools array up to that point).
 *
 * Token usage is `{input_tokens, output_tokens}` plus optional
 * `cache_creation_input_tokens` / `cache_read_input_tokens`. We map the core
 * counts into the runner's `{prompt,completion,total}_tokens` shape and
 * preserve cache stats as optional fields on the same usage object.
 */

type Message = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// RED-323 native document input. Mirrors the shape in documents.ts; the
// provider module deliberately restates the type to keep it a leaf-level
// dependency (unit tests don't need to pull in the whole documents module).
type AnthropicDocumentBlock = {
  key: string;
  kind: 'base64_pdf' | 'base64_image';
  data: string;
  media_type: string;
};

export type AnthropicMessagesResult = {
  message: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  usage?: TokenUsage;
  stop_reason?: string;
};

export type AnthropicMessagesRequestOpts = {
  model: string;           // just the model name, no "anthropic:" prefix
  messages: Message[];     // includes system + user + assistant (with tool_calls) + tool (results)
  tools?: any[];           // OpenAI-format tool definitions; translated to Anthropic shape
  max_tokens?: number;
  temperature?: number;
  cache?: boolean;         // default true — apply cache_control to system block + last tool + last document
  documents?: AnthropicDocumentBlock[];  // RED-323: emitted as content blocks on the FIRST user message
  /** Shared payload emitted as a cache_control:ephemeral text block ahead
   *  of the first user message's content (4th breakpoint: system + last
   *  tool + last document + this). Below MIN_USER_CACHE_CHARS the marker
   *  would be a no-op so the prefix is inlined as
   *  `<prefix>\n\n<user content>` instead. Cache-disabled callers never
   *  reach this — the runner concatenates upstream. */
  cacheUserPrefix?: string;
};

// Cache-floor threshold for the user-prompt prefix. Anthropic's minimum
// cacheable prefix is 1024 tokens (Sonnet/Haiku) — ~4 chars/token gives a
// conservative client-side gate so we don't ship a cache marker the
// server would silently refuse.
export const MIN_USER_CACHE_CHARS = 4096;

/**
 * Build the request body for Anthropic's POST /v1/messages endpoint.
 *
 * Extracts the `system` message (if any) to the top-level `system` field,
 * translates assistant tool_calls → content blocks, translates tool-result
 * messages → user messages with `tool_result` content blocks, and (when
 * `cache` is not explicitly false) marks the system block + last tool as
 * `cache_control: ephemeral` so prompt caching kicks in automatically.
 */
export function buildAnthropicMessagesRequest(opts: AnthropicMessagesRequestOpts): Record<string, any> {
  const useCache = opts.cache !== false;

  // Extract system text from any message with role === 'system'.
  // We concatenate rather than taking only the first so a caller that puts
  // multiple system chunks in the message list (e.g., memory + base prompt)
  // still lands them all in the top-level system field.
  const systemParts: string[] = [];
  const conversation: Message[] = [];
  for (const m of opts.messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else {
      conversation.push(m);
    }
  }
  const systemText = systemParts.join('\n\n');

  // RED-323: document blocks go on the FIRST user-role message in the
  // ORIGINAL conversation (before tool_result turns translated into
  // role:'user'). Tracked with a flag so only the initial prompt carries
  // them; Anthropic's cache_control on the last doc block means
  // subsequent agentic turns hit cache at ~10% cost without repeating
  // the block list.
  const documents = opts.documents ?? [];
  let documentsConsumed = false;
  const buildDocumentBlocks = (): any[] => {
    if (documents.length === 0) return [];
    return documents.map((d, i) => {
      const base: any = {
        type: d.kind === 'base64_pdf' ? 'document' : 'image',
        source: {
          type: 'base64',
          media_type: d.media_type,
          data: d.data,
        },
      };
      // cache_control on the last document caches the whole document
      // block stack up through it — one-shot cache for all docs.
      if (useCache && i === documents.length - 1) {
        base.cache_control = { type: 'ephemeral' };
      }
      return base;
    });
  };

  // Translate the conversation into Anthropic's message + content-block shape.
  const translatedMessages: any[] = [];
  for (const m of conversation) {
    if (m.role === 'assistant') {
      // Assistant turn may be text, tool calls, or both.
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input: any = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            // Leave as empty object — matches how step-handlers.ts treats
            // unparseable arguments on the tool-dispatch side.
            input = {};
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      // An assistant turn with no text and no tool calls is an empty message —
      // Anthropic rejects this. Callers shouldn't produce it, but skip if they do.
      if (blocks.length === 0) continue;
      translatedMessages.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      // Tool-result turn. Anthropic wants this as a user-role message with a
      // tool_result content block. Multiple consecutive tool-result messages
      // would ideally be merged into a single user message with multiple blocks,
      // but the runner's loop emits one tool_call per loop iteration so this
      // is usually 1:1. Merging is a future optimization.
      translatedMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content ?? '',
        }],
      });
      continue;
    }

    // Default: role === 'user' or any other role — pass through.
    // RED-323 + cacheUserPrefix: a first user message gets special handling
    // whenever documents OR a cacheUserPrefix are present. Both anchor on
    // the first user-role message (`documentsConsumed` gates both for the
    // same reason — they belong to the original prompt, not later
    // tool_result turns).
    const userText = m.content ?? '';
    const cacheUserPrefix = opts.cacheUserPrefix;
    const userPrefixEligible =
      useCache && !!cacheUserPrefix && cacheUserPrefix.length >= MIN_USER_CACHE_CHARS;
    if (
      m.role === 'user' &&
      !documentsConsumed &&
      (documents.length > 0 || cacheUserPrefix)
    ) {
      const docBlocks = documents.length > 0 ? buildDocumentBlocks() : [];
      const blocks: any[] = [...docBlocks];
      if (cacheUserPrefix) {
        if (userPrefixEligible) {
          // 4th breakpoint, prefix-first ordering so the cached region
          // extends backward through (documents +) the prefix.
          blocks.push({
            type: 'text',
            text: cacheUserPrefix,
            cache_control: { type: 'ephemeral' },
          });
          // AUD-003: omit the trailing instruction block when empty — Anthropic
          // rejects requests with empty text content blocks (HTTP 400).
          if (userText) blocks.push({ type: 'text', text: userText });
        } else {
          // Below the cache floor: skip the marker — keep prefix-first
          // order so the caller's intent (and any non-Anthropic fallback
          // ordering) stays consistent across the cached/uncached split.
          blocks.push({ type: 'text', text: `${cacheUserPrefix}\n\n${userText}` });
        }
      } else {
        blocks.push({ type: 'text', text: userText });
      }
      translatedMessages.push({ role: 'user', content: blocks });
      documentsConsumed = true;
      continue;
    }
    translatedMessages.push({
      role: m.role,
      content: m.content ?? '',
    });
  }

  // If documents OR a cacheUserPrefix were provided but no user message
  // appeared in the conversation to attach them to, that's a caller bug
  // — silently dropping a large cached payload would mask the wiring
  // mistake. Fail explicit, same rationale as the documents-orphan case.
  if (!documentsConsumed && (documents.length > 0 || opts.cacheUserPrefix)) {
    if (documents.length > 0) {
      throw new Error('Anthropic: documents provided but no user message found to attach them to');
    }
    throw new Error('Anthropic: cacheUserPrefix provided but no user message found to attach it to');
  }

  // Translate OpenAI-format tools → Anthropic format.
  //   OpenAI: {type:'function', function:{name, description, parameters}}
  //   Anthropic: {name, description, input_schema}
  // cache_control on the last tool caches the whole tools array up to and
  // including that tool — one-shot cache for the whole block.
  const translatedTools = opts.tools && opts.tools.length > 0
    ? opts.tools.map((t, i) => {
        const fn = t?.function ?? t;
        const base: any = {
          name: fn.name,
          description: fn.description ?? '',
          input_schema: fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} },
        };
        if (useCache && i === opts.tools!.length - 1) {
          base.cache_control = { type: 'ephemeral' };
        }
        return base;
      })
    : undefined;

  const body: Record<string, any> = {
    model: opts.model,
    max_tokens: opts.max_tokens ?? 1200,
    temperature: opts.temperature ?? 0.2,
    messages: translatedMessages,
  };

  if (systemText) {
    body.system = useCache
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : systemText;
  }

  if (translatedTools) {
    body.tools = translatedTools;
  }

  return body;
}

/**
 * Normalize Anthropic's /v1/messages response into the shape the runner expects.
 *
 * Flattens text blocks into a single string (joined by '' — Anthropic rarely
 * splits prose across blocks but joining without separator matches the
 * model's intended output). Translates tool_use blocks → ToolCallMessage,
 * stringifying the `input` object since the runner's dispatch JSON.parses it.
 */
export function normalizeAnthropicMessagesResponse(json: any): AnthropicMessagesResult {
  const contentBlocks = json?.content;
  if (!Array.isArray(contentBlocks)) {
    throw new Error('Anthropic: missing content array in response');
  }

  const textParts: string[] = [];
  const toolCalls: AnthropicMessagesResult['message']['tool_calls'] = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string') textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: {
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // Ignore other block types (e.g., 'thinking' from extended-thinking models)
    // — they're not surfaced through the runner's current interface. If we
    // want to trace them later, add a dedicated trace step; don't leak them
    // into user-visible content.
  }

  const content = textParts.length > 0 ? textParts.join('') : null;
  const rawUsage = json?.usage;
  const usage: TokenUsage | undefined = rawUsage
    ? {
        prompt_tokens: Number(rawUsage.input_tokens ?? 0),
        completion_tokens: Number(rawUsage.output_tokens ?? 0),
        total_tokens: Number(rawUsage.input_tokens ?? 0) + Number(rawUsage.output_tokens ?? 0),
        ...(rawUsage.cache_creation_input_tokens != null
          ? { cache_creation_input_tokens: Number(rawUsage.cache_creation_input_tokens) }
          : {}),
        ...(rawUsage.cache_read_input_tokens != null
          ? { cache_read_input_tokens: Number(rawUsage.cache_read_input_tokens) }
          : {}),
      }
    : undefined;

  return {
    message: {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    usage,
    stop_reason: json?.stop_reason,
  };
}
