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
};

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
    if (m.role === 'user' && !documentsConsumed && documents.length > 0) {
      // RED-323: prepend document blocks to the FIRST user message. Per
      // Anthropic's guidance, document blocks should precede the text
      // block in the same user message for best attention.
      const docBlocks = buildDocumentBlocks();
      const textBlock = { type: 'text', text: m.content ?? '' };
      translatedMessages.push({
        role: 'user',
        content: [...docBlocks, textBlock],
      });
      documentsConsumed = true;
      continue;
    }
    translatedMessages.push({
      role: m.role,
      content: m.content ?? '',
    });
  }

  // If documents were provided but no user message appeared in the
  // conversation to attach them to, that's a caller bug — Anthropic
  // would reject a request with orphan document blocks. Fail explicit.
  if (documents.length > 0 && !documentsConsumed) {
    throw new Error('Anthropic: documents provided but no user message found to attach them to');
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
