import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiCompatible, anthropicCompatible } from './factories.js';

// RED-393 phase 2: Tier-1 authoring factories. These stub `fetch` to assert
// the request the factory builds and how it normalizes the response — the
// behavior the runner dispatchers used to inline per-provider.

type Captured = { url: string; init: RequestInit };

function stubFetch(response: any, status = 200): () => Captured {
  let captured: Captured | undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    captured = { url, init };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
    } as any;
  });
  return () => captured!;
}

function body(captured: Captured): any {
  return JSON.parse(captured.init.body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openaiCompatible', () => {
  it('builds a /v1/chat/completions request with bearer auth and identity model name', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const p = openaiCompatible({
      name: 'gw',
      baseUrl: 'https://gw.example.com/',
      auth: () => 'sek',
    });
    const res = await p.generateText({ model: 'gpt-4o', system: 's', prompt: 'u' });
    const c = get();
    expect(c.url).toBe('https://gw.example.com/v1/chat/completions');
    expect((c.init.headers as any).authorization).toBe('Bearer sek');
    const b = body(c);
    expect(b.model).toBe('gpt-4o');
    expect(b.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
    expect(res).toEqual({ text: 'hi', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  });

  it('omits the Authorization header when auth returns undefined', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const p = openaiCompatible({ name: 'gw', baseUrl: 'http://localhost:8080', auth: () => undefined });
    await p.generateText({ model: 'm', system: 's', prompt: 'u' });
    expect((get().init.headers as any).authorization).toBeUndefined();
  });

  it('applies a modelName transform to the wire id only', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const p = openaiCompatible({
      name: 'azure',
      baseUrl: 'https://az',
      modelName: { 'gpt-4o': 'prod-deploy' },
    });
    await p.generateText({ model: 'gpt-4o', system: 's', prompt: 'u' });
    expect(body(get()).model).toBe('prod-deploy');
  });

  it('thinkingSuppression injects /no_think and chat_template_kwargs only when disable_thinking', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const p = openaiCompatible({ name: 'omlx', baseUrl: 'http://x', thinkingSuppression: true });
    await p.generateText({ model: 'qwen3', system: 'S', prompt: 'P', modelOptions: { disable_thinking: true } });
    const b = body(get());
    expect(b.messages[0].content).toBe('/no_think\nS');
    expect(b.messages[1].content).toBe('P\n/no_think');
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('does not inject /no_think when thinkingSuppression is off', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const p = openaiCompatible({ name: 'gw', baseUrl: 'http://x' });
    await p.generateText({ model: 'm', system: 'S', prompt: 'P', modelOptions: { disable_thinking: true } });
    const b = body(get());
    expect(b.messages[0].content).toBe('S');
    expect(b.chat_template_kwargs).toBeUndefined();
  });

  it('gates structured_outputs / response_format on their callbacks + a jsonSchema', async () => {
    const get = stubFetch({ choices: [{ message: { content: 'x' } }] });
    const p = openaiCompatible({
      name: 'omlx',
      baseUrl: 'http://x',
      structuredOutputs: () => true,
      responseFormat: () => false,
    });
    const schema = { $id: 'Foo', type: 'object' };
    await p.generateText({ model: 'm', system: 's', prompt: 'u', jsonSchema: schema });
    const b = body(get());
    expect(b.extra_body).toEqual({ structured_outputs: { json: schema } });
    expect(b.response_format).toBeUndefined();
  });

  it('falls back to reasoning_content when content is empty (and enabled)', async () => {
    const get = stubFetch({ choices: [{ message: { content: '', reasoning_content: 'the answer' } }] });
    const p = openaiCompatible({ name: 'omlx', baseUrl: 'http://x', reasoningContentFallback: true });
    const res = await p.generateText({ model: 'm', system: 's', prompt: 'u' });
    expect(res.text).toBe('the answer');
    get();
  });

  it('surfaces upstream error body when surfaceErrorBody is on', async () => {
    stubFetch('boom detail', 500);
    const p = openaiCompatible({ name: 'omlx', baseUrl: 'http://x', errorLabel: 'oMLX', surfaceErrorBody: true });
    await expect(p.generateText({ model: 'm', system: 's', prompt: 'u' })).rejects.toThrow(
      /oMLX error: HTTP 500 — boom detail/,
    );
  });

  it('hides upstream error body by default', async () => {
    stubFetch('secret', 500);
    const p = openaiCompatible({ name: 'gw', baseUrl: 'http://x' });
    await expect(p.generateText({ model: 'm', system: 's', prompt: 'u' })).rejects.toThrow(/gw error: HTTP 500$/);
  });

  it('generateWithTools sets tool_choice none when no tools, and returns raw tool_calls', async () => {
    const get = stubFetch({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] } }],
    });
    const p = openaiCompatible({ name: 'gw', baseUrl: 'http://x' });
    const res = await p.generateWithTools({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(body(get()).tool_choice).toBe('none');
    expect(res.message.tool_calls?.[0].id).toBe('c1');
  });
});

describe('anthropicCompatible', () => {
  it('builds a /v1/messages request with x-api-key + anthropic-version', async () => {
    const get = stubFetch({ content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 4, output_tokens: 6 } });
    const p = anthropicCompatible({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: () => 'k',
    });
    const res = await p.generateText({ model: 'claude-x', system: 's', prompt: 'u' });
    const c = get();
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect((c.init.headers as any)['x-api-key']).toBe('k');
    expect((c.init.headers as any)['anthropic-version']).toBe('2023-06-01');
    expect(res.text).toBe('hello');
    expect(res.usage?.prompt_tokens).toBe(4);
  });

  it('throws the configured missing-key message when apiKey returns undefined', async () => {
    stubFetch({ content: [] });
    const p = anthropicCompatible({
      name: 'anthropic',
      baseUrl: 'https://x',
      apiKey: () => undefined,
      missingKeyMessage: 'need a key',
    });
    await expect(p.generateText({ model: 'm', system: 's', prompt: 'u' })).rejects.toThrow('need a key');
  });

  it('never surfaces the upstream error body (credential posture)', async () => {
    stubFetch('401 body with key fragment', 401);
    const p = anthropicCompatible({ name: 'anthropic', baseUrl: 'https://x', apiKey: () => 'k', errorLabel: 'Anthropic' });
    const err = await p.generateText({ model: 'm', system: 's', prompt: 'u' }).catch((e) => e);
    expect(String(err.message)).toBe('Anthropic error: HTTP 401');
    expect(String(err.message)).not.toContain('fragment');
  });
});
