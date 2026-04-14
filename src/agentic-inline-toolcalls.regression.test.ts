import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { handleAgenticGenerate } from './step-handlers.js';
import { ToolRegistry } from './tools/registry.js';

/**
 * Regression: run_20260409_234441_85b562
 *
 * Gemma returns tool calls as inline markup in message.content rather than
 * as native OpenAI-format tool_calls. Before RED-142, this markup was treated
 * as final output, JSON parsing failed, and the Repair step fabricated a
 * placeholder answer.
 *
 * Expected behavior: inline markup is parsed and the tool is invoked as if
 * it were a native tool call; final-output parsing only happens once both
 * native and parsed-inline tool calls are absent.
 */
describe('agentic mode — inline tool call regression', () => {
  it('executes an inline <|tool_call> from Gemma and produces a final JSON answer', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'));

    const ir = {
      model: { id: 'omlx:gemma-mock', max_tokens: 512, temperature: 0.2 },
      system: 'You are a math agent.',
      context: { document: 'Samples: 10, 20, 30' },
      policies: {},
    };

    const schema = {
      $id: 'MockSchema',
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    };

    // Track what the mocked model was asked to do across turns.
    const turns: Array<{ messages: any[]; tools: any[] }> = [];
    let turnIdx = 0;

    const generateWithTools = async (opts: any) => {
      turns.push({ messages: opts.messages, tools: opts.tools });
      turnIdx++;
      // Turn 1: model returns inline Gemma markup (no native tool_calls).
      if (turnIdx === 1) {
        return {
          message: {
            content:
              '<|tool_call>call:calculator{operation:<|"avg"|>,operands:[10,20,30]}</tool_call>',
            tool_calls: undefined,
          },
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };
      }
      // Turn 2: after receiving the tool result, model emits the final answer.
      return {
        message: { content: '{"answer": 20}', tool_calls: undefined },
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      };
    };

    const extractJson = (text: string) => JSON.parse(text);

    const result = await handleAgenticGenerate(
      { id: 'gen_mock', prompt: 'Compute the average.' },
      ir,
      schema,
      toolRegistry.toOpenAIFormat(['calculator']),
      toolRegistry,
      ['calculator'],
      generateWithTools,
      extractJson,
      /* maxToolCalls */ 5,
    );

    // Final answer was produced (no fabricated placeholder, no repair).
    expect(result.result.ok).toBe(true);
    expect(result.parsed).toEqual({ answer: 20 });

    // Tool was actually executed on turn 1.
    const agenticTurn = result.traceSteps.find(s => s.type === 'AgenticTurn');
    expect(agenticTurn).toBeDefined();
    expect(agenticTurn!.meta?.tool_calls?.[0]?.name).toBe('calculator');

    // Turn 2's message history includes a 'tool' role result from calculator.
    expect(turns.length).toBe(2);
    const toolMsg = turns[1].messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg.content).value).toBe(20);
  });
});
