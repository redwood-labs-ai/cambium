/**
 * #205 STEP-002 (DEC-004): the agentic loop's `--mock` short-circuit needs
 * the step's schema too — under mock, `generateWithTools` returns a single
 * turn of text with no tool_calls, and that text IS the final output, so it
 * has to go through the same schema-derived mock as the non-agentic path.
 *
 * Three claims:
 *   (a) `handleAgenticGenerate` passes the step's schema to `generateWithTools`
 *       as `opts.jsonSchema` (direct harness, no runner).
 *   (b) end-to-end: a `runGen` with `mode: 'agentic'`, no tools, `mock: true`,
 *       and an inline schema the default payload doesn't fit still validates.
 *   (c) the schema is NEVER forwarded to a real provider's `generateWithTools`
 *       — `_testProviders` injection proves the live dispatch path is untouched.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { handleAgenticGenerate } from './step-handlers.js';
import { ToolRegistry } from './tools/registry.js';
import { runGen } from './runner.js';
import type { CambiumProvider } from './providers/types.js';

const BUILTINS = join(process.cwd(), 'packages/cambium-runner/src/builtin-tools');
const APP_TOOLS = join(process.cwd(), 'packages/cambium/app/tools');

describe('#205 (DEC-004) — agentic mock gets the schema', () => {
  it('(a) handleAgenticGenerate passes the step schema to generateWithTools as opts.jsonSchema', async () => {
    const registry = new ToolRegistry();
    await registry.loadFromDir(BUILTINS);
    await registry.loadFromDir(APP_TOOLS);

    const schema = {
      $id: 'ProbeOutput',
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    };

    const receivedSchemas: any[] = [];
    const generateWithTools = async (opts: any) => {
      receivedSchemas.push(opts.jsonSchema);
      return { message: { content: '{"answer": 42}', tool_calls: undefined } };
    };

    const result = await handleAgenticGenerate(
      { id: 'gen_probe', prompt: 'Answer.' },
      { model: { id: 'omlx:mock', max_tokens: 512, temperature: 0.2 }, system: 'You are a probe agent.', context: { document: 'doc' }, policies: {} },
      schema,
      registry.toOpenAIFormat([]),
      registry,
      [],
      generateWithTools,
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 5,
      {},
    );

    expect(result.parsed).toEqual({ answer: 42 });
    expect(receivedSchemas).toEqual([schema]);
  });

  it('(b) a mock agentic runGen validates against an inline schema the default payload lacks', async () => {
    const ir: any = {
      version: '0.2',
      entry: { class: 'AgenticInline', method: 'analyze', source: 'inline.cmb.rb' },
      model: { id: 'omlx:test-model', temperature: 0.1, max_tokens: 512 },
      system: 'test system',
      mode: 'agentic' as const,
      policies: {
        tools_allowed: [],
        correctors: [],
        constraints: {},
        grounding: null,
        security: {},
      },
      returnSchema: {
        $id: 'AgenticInlineOutput',
        type: 'object',
        properties: {
          title: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['title', 'score'],
        additionalProperties: false,
      },
      context: { document: 'test document' },
      enrichments: [],
      signals: [],
      triggers: [],
      steps: [
        {
          id: 'generate_1',
          type: 'Generate' as const,
          prompt: 'say something',
          with: { context: 'test document' },
          returns: null,
        },
      ],
    };

    const result = await runGen({ ir, schemas: {}, mock: true });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ title: 'mock title', score: 0 });
  });

  it('(c) jsonSchema is never forwarded to a real provider\'s generateWithTools', async () => {
    const receivedOpts: any[] = [];
    const fakeProvider: CambiumProvider = {
      name: 'fakeagentic',
      supportsDocuments: false,
      async generateText() {
        throw new Error('not configured');
      },
      async generateWithTools(opts: any) {
        receivedOpts.push(opts);
        return { message: { content: '{"title": "from-provider", "score": 1}', tool_calls: [] } };
      },
    };

    const ir: any = {
      version: '0.2',
      entry: { class: 'AgenticInline', method: 'analyze', source: 'inline.cmb.rb' },
      model: { id: 'fakeagentic:m1', temperature: 0.1, max_tokens: 512 },
      system: 'test system',
      mode: 'agentic' as const,
      policies: {
        tools_allowed: [],
        correctors: [],
        constraints: {},
        grounding: null,
        security: {},
      },
      returnSchema: {
        $id: 'AgenticInlineOutput',
        type: 'object',
        properties: {
          title: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['title', 'score'],
        additionalProperties: false,
      },
      context: { document: 'test document' },
      enrichments: [],
      signals: [],
      triggers: [],
      steps: [
        {
          id: 'generate_1',
          type: 'Generate' as const,
          prompt: 'say something',
          with: { context: 'test document' },
          returns: null,
        },
      ],
    };

    const result = await runGen({
      ir,
      schemas: {},
      _testProviders: new Map([['fakeagentic', fakeProvider]]),
    });

    expect(result.ok).toBe(true);
    expect(receivedOpts).toHaveLength(1);
    expect('jsonSchema' in receivedOpts[0]).toBe(false);
  });
});
