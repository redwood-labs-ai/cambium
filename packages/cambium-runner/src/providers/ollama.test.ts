import { describe, it, expect } from 'vitest';
import { buildOllamaChatRequest, normalizeOllamaChatResponse } from './ollama.js';

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
