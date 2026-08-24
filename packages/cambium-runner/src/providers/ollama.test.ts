import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOllamaChatRequest, normalizeOllamaChatResponse, toOllamaToolCalls } from './ollama.js';
import { ollamaProvider } from './builtins.js';

describe('buildOllamaChatRequest', () => {
  it('emits a /api/chat-shaped body', () => {
    const body = buildOllamaChatRequest({
      model: 'qwen3:8b',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [],
      max_tokens: 500,
      temperature: 0.3,
    });
    expect(body.model).toBe('qwen3:8b');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(500);
    expect(body.options.temperature).toBe(0.3);
    expect(body.messages).toHaveLength(2);
    expect(body.tools).toBeUndefined();
  });

  it('includes tools when present', () => {
    const tools = [{ type: 'function', function: { name: 'calculator', description: 'x', parameters: {} } }];
    const body = buildOllamaChatRequest({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'q' }],
      tools,
    });
    expect(body.tools).toEqual(tools);
  });

  it('applies sensible defaults for temperature and max_tokens', () => {
    const body = buildOllamaChatRequest({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
    });
    expect(body.options.temperature).toBe(0.2);
    expect(body.options.num_predict).toBe(1200);
  });

  it('converts stringified assistant tool-call arguments to objects on continuation turns (#153)', () => {
    const body = buildOllamaChatRequest({
      model: 'qwen3:8b',
      messages: [
        { role: 'user', content: 'list jobs' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_jobs', arguments: '{}' } }],
        },
        { role: 'tool', content: '{"jobs":[]}', tool_call_id: 'c1' },
      ],
      tools: [],
    });
    const replayed = body.messages[1].tool_calls[0];
    expect(replayed.function.arguments).toEqual({});
    expect(typeof replayed.function.arguments).not.toBe('string');
  });

  it('parses non-trivial stringified arguments into their object form', () => {
    const out = toOllamaToolCalls([
      { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"foo"}' } },
    ]);
    expect(out![0].function.arguments).toEqual({ query: 'foo' });
  });

  it('treats empty-string arguments as {} and passes object-shaped values through untouched', () => {
    const out = toOllamaToolCalls([
      { function: { name: 'a', arguments: '' } },
      { function: { name: 'b', arguments: { k: 1 } } },
    ]);
    expect(out![0].function.arguments).toEqual({});
    expect(out![1].function.arguments).toEqual({ k: 1 });
  });

  it('does not mutate the caller-side messages (internal string form is preserved)', () => {
    const toolCall = { id: 'c1', type: 'function', function: { name: 't', arguments: '{"k":"v"}' } };
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [toolCall] },
    ];
    buildOllamaChatRequest({ model: 'm', messages, tools: [] });
    expect(toolCall.function.arguments).toBe('{"k":"v"}');
  });

  it('returns undefined for absent tool_calls without altering the message shape', () => {
    const userMsg = { role: 'user', content: 'q' };
    const body = buildOllamaChatRequest({ model: 'm', messages: [userMsg], tools: [] });
    expect(body.messages[0]).toBe(userMsg);
  });
});

describe('normalizeOllamaChatResponse', () => {
  it('normalizes a plain-content response', () => {
    const out = normalizeOllamaChatResponse({
      message: { role: 'assistant', content: 'final answer' },
      prompt_eval_count: 10,
      eval_count: 20,
    });
    expect(out.message.content).toBe('final answer');
    expect(out.message.tool_calls).toBeUndefined();
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it('synthesizes tool call IDs when Ollama omits them', () => {
    const out = normalizeOllamaChatResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'calculator', arguments: { operation: 'avg', operands: [1, 2, 3] } } },
        ],
      },
    });
    const calls = out.message.tool_calls!;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toMatch(/^call_ollama_0_calculator$/);
    expect(calls[0].type).toBe('function');
    expect(calls[0].function.name).toBe('calculator');
  });

  it('stringifies object-shaped function.arguments', () => {
    const out = normalizeOllamaChatResponse({
      message: {
        content: null,
        tool_calls: [{ function: { name: 'web_search', arguments: { query: 'foo' } } }],
      },
    });
    const args = out.message.tool_calls![0].function.arguments;
    expect(typeof args).toBe('string');
    expect(JSON.parse(args)).toEqual({ query: 'foo' });
  });

  it('passes through already-stringified arguments unchanged', () => {
    const out = normalizeOllamaChatResponse({
      message: {
        content: null,
        tool_calls: [{ function: { name: 't', arguments: '{"k":"v"}' } }],
      },
    });
    expect(out.message.tool_calls![0].function.arguments).toBe('{"k":"v"}');
  });

  it('handles empty tool_calls array', () => {
    const out = normalizeOllamaChatResponse({
      message: { content: 'hi', tool_calls: [] },
    });
    expect(out.message.tool_calls).toEqual([]);
  });

  it('omits usage when no token counts provided', () => {
    const out = normalizeOllamaChatResponse({
      message: { content: 'hi' },
    });
    expect(out.usage).toBeUndefined();
  });

  it('throws on missing message', () => {
    expect(() => normalizeOllamaChatResponse({})).toThrow(/missing message/);
  });

  it('unique IDs across multiple tool calls in one turn', () => {
    const out = normalizeOllamaChatResponse({
      message: {
        content: null,
        tool_calls: [
          { function: { name: 'a', arguments: {} } },
          { function: { name: 'b', arguments: {} } },
          { function: { name: 'a', arguments: {} } },
        ],
      },
    });
    const ids = out.message.tool_calls!.map(c => c.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// HTTP-error surfacing tests for the ollamaProvider (bespoke CambiumProvider).
// These stub global `fetch` to simulate non-2xx responses from the Ollama server.

function stubOllamaFetch(body: string, status: number): void {
  vi.stubGlobal('fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => { throw new Error('not a json response'); },
  } as any));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ollamaProvider HTTP errors', () => {
  it('surfaces and redacts upstream error body on generateText HTTP error', async () => {
    stubOllamaFetch('{"error":"Bearer sk-fakefaketoken12345 is invalid"}', 500);
    const err: Error = await ollamaProvider
      .generateText({ model: 'm', system: 's', prompt: 'u' })
      .catch((e) => e);
    expect(err.message).toMatch(/Ollama error: HTTP 500 —/);
    expect(err.message).not.toContain('sk-fakefaketoken12345');
    expect(err.message).toContain('[REDACTED]');
  });

  it('surfaces benign Ollama error body unredacted on generateText', async () => {
    stubOllamaFetch('model "qwen3:8b" not found, try pulling it first', 404);
    const err: Error = await ollamaProvider
      .generateText({ model: 'qwen3:8b', system: 's', prompt: 'u' })
      .catch((e) => e);
    expect(err.message).toContain('Ollama error: HTTP 404 —');
    expect(err.message).toContain('not found');
  });

  it('surfaces and redacts upstream error body on generateWithTools HTTP error', async () => {
    stubOllamaFetch('{"error":"api_key=sk-fakefaketoken12345 rejected"}', 401);
    const err: Error = await ollamaProvider
      .generateWithTools({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })
      .catch((e) => e);
    expect(err.message).toMatch(/Ollama error: HTTP 401 —/);
    expect(err.message).not.toContain('sk-fakefaketoken12345');
    expect(err.message).toContain('[REDACTED]');
  });
});
