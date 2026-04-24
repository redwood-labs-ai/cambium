import { describe, it, expect } from 'vitest';
import { buildAnthropicMessagesRequest, normalizeAnthropicMessagesResponse } from './anthropic.js';

describe('buildAnthropicMessagesRequest', () => {
  it('extracts system role to top-level system with cache_control', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'you are a helpful assistant' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.system).toEqual([
      { type: 'text', text: 'you are a helpful assistant', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('omits system when no system message present', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.system).toBeUndefined();
  });

  it('joins multiple system messages with blank line', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'base prompt' },
        { role: 'system', content: 'memory context' },
        { role: 'user', content: 'q' },
      ],
    });
    expect(body.system[0].text).toBe('base prompt\n\nmemory context');
  });

  it('uses plain-string system when cache disabled', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ],
      cache: false,
    });
    expect(body.system).toBe('sys');
  });

  it('applies defaults for max_tokens and temperature', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(body.max_tokens).toBe(1200);
    expect(body.temperature).toBe(0.2);
  });

  it('respects explicit max_tokens and temperature', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 500,
      temperature: 0.7,
    });
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0.7);
  });

  it('translates OpenAI-format tools → Anthropic shape with cache on last tool', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'compute' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'math',
            parameters: { type: 'object', properties: { operation: { type: 'string' } } },
          },
        },
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
      ],
    });
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({
      name: 'calculator',
      description: 'math',
      input_schema: { type: 'object', properties: { operation: { type: 'string' } } },
    });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits tool cache_control when cache disabled', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
      cache: false,
    });
    expect(body.tools[0].cache_control).toBeUndefined();
  });

  it('omits tools key when none provided', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(body.tools).toBeUndefined();
  });

  it('translates assistant tool_calls into tool_use content blocks', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'compute 2+2' },
        {
          role: 'assistant',
          content: 'let me compute',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'calculator', arguments: '{"operation":"add","operands":[2,2]}' },
            },
          ],
        },
      ],
    });
    const assistantMsg = body.messages[1];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toEqual([
      { type: 'text', text: 'let me compute' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'calculator',
        input: { operation: 'add', operands: [2, 2] },
      },
    ]);
  });

  it('tool_use input defaults to {} when arguments unparseable', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: 'not json' } }],
        },
      ],
    });
    const tu = body.messages[1].content[0];
    expect(tu.input).toEqual({});
  });

  it('translates tool-result messages into user tool_result blocks', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'compute' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{}' } }],
        },
        { role: 'tool', content: '{"result":4}', tool_call_id: 'call_1' },
      ],
    });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"result":4}' }],
    });
  });

  it('skips empty assistant messages that have neither text nor tool calls', () => {
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null },
      ],
    });
    expect(body.messages).toHaveLength(1);
  });
});

describe('normalizeAnthropicMessagesResponse', () => {
  it('flattens text blocks into a single content string', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(out.message.content).toBe('hello world');
    expect(out.message.tool_calls).toBeUndefined();
    expect(out.stop_reason).toBe('end_turn');
  });

  it('joins multiple text blocks without separator', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'text', text: 'part two' },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(out.message.content).toBe('part one part two');
  });

  it('normalizes tool_use blocks into ToolCallMessage shape', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'calculator',
          input: { operation: 'add', operands: [1, 2] },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(out.message.content).toBeNull();
    expect(out.message.tool_calls).toHaveLength(1);
    expect(out.message.tool_calls![0]).toEqual({
      id: 'toolu_abc',
      type: 'function',
      function: {
        name: 'calculator',
        arguments: '{"operation":"add","operands":[1,2]}',
      },
    });
  });

  it('handles mixed text + tool_use content', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [
        { type: 'text', text: 'let me compute' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'calculator',
          input: {},
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(out.message.content).toBe('let me compute');
    expect(out.message.tool_calls).toHaveLength(1);
  });

  it('normalizes usage without cache stats', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(out.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it('preserves cache_creation/read stats in usage', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      },
    });
    expect(out.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 800,
    });
  });

  it('omits usage when not present', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(out.usage).toBeUndefined();
  });

  it('ignores unknown block types (e.g., thinking)', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: 'visible answer' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(out.message.content).toBe('visible answer');
  });

  it('throws on missing content array', () => {
    expect(() => normalizeAnthropicMessagesResponse({})).toThrow(/missing content array/);
  });

  it('stringifies tool_use input for downstream JSON.parse', () => {
    const out = normalizeAnthropicMessagesResponse({
      content: [
        { type: 'tool_use', id: 'x', name: 'web_search', input: { query: 'foo' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const args = out.message.tool_calls![0].function.arguments;
    expect(typeof args).toBe('string');
    expect(JSON.parse(args)).toEqual({ query: 'foo' });
  });
});

describe('buildAnthropicMessagesRequest → normalizeAnthropicMessagesResponse round-trip', () => {
  it('tool-call → tool-result round-trip translates through both shapes', () => {
    // Model first response: tool_use only
    const firstResponse = normalizeAnthropicMessagesResponse({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'calc', input: { op: 'add' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    // Runner would build the next turn with the assistant's tool call +
    // the tool result. Round-trip that through the request builder.
    const body = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'compute' },
        {
          role: 'assistant',
          content: firstResponse.message.content,
          tool_calls: firstResponse.message.tool_calls,
        },
        { role: 'tool', content: '{"result":7}', tool_call_id: 'toolu_1' },
      ],
    });

    // Three messages: user, assistant (with tool_use block), user (with tool_result block)
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'calc',
      input: { op: 'add' },
    });
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: '{"result":7}',
    });
  });
});
