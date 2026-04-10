import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tools/registry.js';
import { handleAgenticGenerate } from './step-handlers.js';

function extractJson(text: string) {
  // naive but sufficient for unit tests
  return JSON.parse(text);
}

describe('agentic loop inline tool calls (Gemma-style)', () => {
  it('executes inline <|tool_call|> and continues to final JSON answer', async () => {
    const registry = new ToolRegistry();
    registry.loadFromDir('packages/cambium/app/tools');

    const ir = {
      model: { id: 'omlx:fake', temperature: 0.0, max_tokens: 200 },
      system: 'You are a test agent.',
      context: { document: 'QUESTION: add 2 and 2.' },
      policies: { tools_allowed: ['calculator'], constraints: {}, grounding: null },
    };

    const step = { id: 's1', prompt: 'Compute 2+2 using tools. Then answer as JSON.' };
    const schema = {
      $id: 'GaiaAnswer',
      type: 'object',
      additionalProperties: false,
      properties: { reasoning: { type: 'string' }, answer: { type: 'string' } },
      required: ['reasoning', 'answer'],
    };

    let callCount = 0;
    const generateWithTools = async (opts: any) => {
      callCount++;
      // First call: model emits inline tool-call markup (no native tool_calls)
      if (callCount === 1) {
        return {
          message: {
            content:
              '<|tool_call>call:calculator{operation:<|"|>sum<|"|>,operands:[2,2]}<tool_call|>',
          },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }

      // Second call: after tool execution, model returns final JSON
      return {
        message: {
          content: JSON.stringify({ reasoning: 'used calculator', answer: '4' }),
        },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };

    const toolsOpenAI = registry.toOpenAIFormat(['calculator']);

    const { parsed, result, traceSteps } = await handleAgenticGenerate(
      step,
      ir,
      schema,
      toolsOpenAI,
      registry,
      ['calculator'],
      generateWithTools,
      extractJson,
      2,
    );

    expect(result.ok).toBe(true);
    expect(parsed).toEqual({ reasoning: 'used calculator', answer: '4' });

    // Should have recorded a turn with a tool call
    const turn = traceSteps.find(s => s.type === 'AgenticTurn');
    expect(turn?.meta?.tool_calls?.length).toBe(1);
    expect(turn?.meta?.tool_calls?.[0]?.name).toBe('calculator');
  });
});
