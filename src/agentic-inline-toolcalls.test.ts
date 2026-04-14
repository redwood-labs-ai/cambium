import { describe, it, expect } from 'vitest';
import { parseInlineToolCalls, stripInlineToolCalls } from './inline-tool-calls.js';

describe('parseInlineToolCalls', () => {
  it('parses Gemma format tool calls', () => {
    const content = '<|tool_call>call:web_search{query:<|"hello world"|>}</tool_call>';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('function');
    expect(calls[0].function.name).toBe('web_search');
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.query).toBe('hello world');
  });

  it('parses Gemma tool calls with <tool_call|> closing variant', () => {
    const content = '<|tool_call>call:web_search{query:<|"hello"|>}<tool_call|>';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('web_search');
    expect(JSON.parse(calls[0].function.arguments).query).toBe('hello');
  });

  it('parses multiple Gemma tool calls', () => {
    const content = '<|tool_call>call:search{q:<|"a"|>}</tool_call><|tool_call>call:lookup{id:<|"1"|>}</tool_call>';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe('search');
    expect(calls[1].function.name).toBe('lookup');
  });

  it('parses generic XML tool calls', () => {
    const content = '<tool_call>{"name":"calculator","arguments":{"expression":"2+2"}}</tool_call>';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('calculator');
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.expression).toBe('2+2');
  });

  it('returns empty for plain content with no tool calls', () => {
    const content = 'This is just a regular JSON response.';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(0);
  });

  it('prefers Gemma format when both formats could match', () => {
    const content = '<|tool_call>call:my_tool{arg:<|"val"|>}</tool_call>';
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('my_tool');
  });
});

describe('stripInlineToolCalls', () => {
  it('strips Gemma tool calls and returns remaining text', () => {
    const content = 'Here is my answer: {"key":"value"}\n<|tool_call>call:search{q:<|"x"|>}</tool_call>';
    const stripped = stripInlineToolCalls(content);
    expect(stripped).toBe('Here is my answer: {"key":"value"}');
  });

  it('strips XML tool calls and returns remaining text', () => {
    const content = 'Final answer:\n<tool_call>{"name":"tool","arguments":{}}</tool_call>\n{"result":true}';
    const stripped = stripInlineToolCalls(content);
    expect(stripped).toContain('Final answer:');
    expect(stripped).toContain('{"result":true}');
  });

  it('returns empty string when content is only tool calls', () => {
    const content = '<|tool_call>call:tool{x:<|"1"|>}</tool_call>';
    const stripped = stripInlineToolCalls(content);
    expect(stripped).toBe('');
  });

  it('returns content unchanged when no tool calls present', () => {
    const content = '{"answer":"hello"}';
    const stripped = stripInlineToolCalls(content);
    expect(stripped).toBe('{"answer":"hello"}');
  });
});
