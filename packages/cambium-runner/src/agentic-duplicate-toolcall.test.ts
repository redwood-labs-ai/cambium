/**
 * RED-184: the agentic loop had no memory of prior tool calls, so a model that
 * got an unsatisfying result could re-issue the exact same call forever.
 * Observed: one quantized 35B model repeated a single web_search across 39
 * turns until the 87k-token transcript blew the provider's context window.
 *
 * Expected behavior: an exact-duplicate call (fnName + args) is not re-dispatched;
 * the model is told it already made that call; the call still counts against the
 * budget so the existing max_tool_calls backstop keeps its teeth.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { handleAgenticGenerate } from './step-handlers.js';
import { ToolRegistry } from './tools/registry.js';
import { testOverrideHandlers } from './tools/index.js';
import { Budget } from './budget.js';

const BUILTINS = join(process.cwd(), 'packages/cambium-runner/src/builtin-tools');
const APP_TOOLS = join(process.cwd(), 'packages/cambium/app/tools');

const registry = new ToolRegistry();
await registry.loadFromDir(BUILTINS);
await registry.loadFromDir(APP_TOOLS);

// Pure shim: def on the registry, handler in testOverrideHandlers (no fixture
// file needed). Counts how many times each distinct args object is dispatched.
const calls: Record<string, number> = {};
(registry as any).defs.set('probe', {
  name: 'probe',
  description: 'probe tool',
  permissions: { pure: true },
  inputSchema: {},
  outputSchema: {},
});
testOverrideHandlers['probe'] = async (input: any) => {
  calls[input.q] = (calls[input.q] ?? 0) + 1;
  return { value: 42, q: input.q };
};

describe('agentic mode — exact-duplicate tool call guard', () => {
  it('skips the re-dispatch but keeps counting the call', async () => {
    const budget = new Budget({ max_calls: 10 }, {});
    const turns: any[][] = [];

    const generateWithTools = async (opts: any) => {
      turns.push(opts.messages);
      const turn = turns.length;
      if (turn === 1) {
        return {
          message: {
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } }],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      if (turn === 2) {
        // Repeat of turn 1 verbatim, plus one call the model has not made yet.
        return {
          message: {
            content: null,
            tool_calls: [
              { id: 'c2', type: 'function', function: { name: 'probe', arguments: '{"q":"x"}' } },
              { id: 'c3', type: 'function', function: { name: 'probe', arguments: '{"q":"y"}' } },
            ],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        message: { content: '{"answer": 42}', tool_calls: undefined },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    const result = await handleAgenticGenerate(
      { id: 'gen_probe', prompt: 'Answer.' },
      { model: { id: 'omlx:mock', max_tokens: 512, temperature: 0.2 }, system: 'You are a probe agent.', context: { document: 'doc' }, policies: {} },
      { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
      registry.toOpenAIFormat(['probe']),
      registry,
      ['probe'],
      generateWithTools,
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 10,
      { budget },
    );

    expect(result.parsed).toEqual({ answer: 42 });

    // "x" dispatched once even though the model asked for it twice.
    expect(calls).toEqual({ x: 1, y: 1 });

    // The duplicate is visible in the transcript handed back to the model,
    // and in the trace, and still costs a tool call against the budget.
    const toolMsgs = turns[2].filter(m => m.role === 'tool'); // x, duplicate-of-x, y
    expect(toolMsgs.length).toBe(3);
    const dup = JSON.parse(toolMsgs[1].content);
    expect(dup.duplicate).toBe(true);
    expect(dup.previous_result).toContain('42');
    expect(JSON.parse(toolMsgs[2].content).q).toBe('y');

    const turn2 = result.traceSteps.find(s => s.type === 'AgenticTurn' && s.meta.turn === 2)!;
    expect(turn2.meta.results.map((r: any) => r.duplicate)).toEqual([true, undefined]);

    // Three model turns: ask, ask-again (one skipped), answer.
    expect(turns.length).toBe(3);
    // Distinct args still dispatch ("y" ran once); duplicates still bill.
    expect(budget.getToolUsage('probe').calls).toBe(3);
    expect(result.result.meta.total_tool_calls).toBe(3);
  });

  // The guard remembers RESULTS, not attempts. A tool that throws has not
  // answered the call, so caching the throw would make the retry — the move
  // every agentic loop makes after a transient failure — impossible for the
  // rest of the run, and would file the replay as `ok: true` when the real
  // call was `ok: false`.
  it('does not memoize a failed call — the retry still dispatches', async () => {
    let dispatches = 0;
    (registry as any).defs.set('flaky', {
      name: 'flaky',
      description: 'fails once, then succeeds',
      permissions: { pure: true },
      inputSchema: {},
      outputSchema: {},
    });
    testOverrideHandlers['flaky'] = async () => {
      dispatches++;
      if (dispatches === 1) throw new Error('transient: connection reset');
      return { recovered: true };
    };

    const turns: any[][] = [];
    const generateWithTools = async (opts: any) => {
      turns.push(opts.messages);
      const turn = turns.length;
      // Same call twice: turn 1 fails, turn 2 is the retry.
      if (turn <= 2) {
        return {
          message: {
            content: null,
            tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: 'flaky', arguments: '{"q":"x"}' } }],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        message: { content: '{"answer": 7}', tool_calls: undefined },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    const result = await handleAgenticGenerate(
      { id: 'gen_flaky', prompt: 'Answer.' },
      { model: { id: 'omlx:mock', max_tokens: 512, temperature: 0.2 }, system: 'You are a probe agent.', context: { document: 'doc' }, policies: {} },
      { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
      registry.toOpenAIFormat(['flaky']),
      registry,
      ['flaky'],
      generateWithTools,
      (t: string) => JSON.parse(t),
      /* maxToolCalls */ 10,
      {},
    );

    // The retry reached the handler and recovered.
    expect(dispatches).toBe(2);
    expect(result.parsed).toEqual({ answer: 7 });

    // Neither turn is reported as a duplicate, and the failure stays `ok: false`.
    const turn1 = result.traceSteps.find(s => s.type === 'AgenticTurn' && s.meta.turn === 1)!;
    const turn2 = result.traceSteps.find(s => s.type === 'AgenticTurn' && s.meta.turn === 2)!;
    expect(turn1.meta.results.map((r: any) => r.duplicate)).toEqual([undefined]);
    expect(turn2.meta.results.map((r: any) => r.duplicate)).toEqual([undefined]);

    // The model saw the real error, then the real recovery — no replay.
    const retryMsg = JSON.parse(turns[2].filter(m => m.role === 'tool').at(-1)!.content);
    expect(retryMsg.duplicate).toBeUndefined();
    expect(retryMsg.recovered).toBe(true);

    // Once it succeeds, the guard arms: a THIRD identical call would be
    // answered from memory rather than re-dispatched.
    expect(dispatches).toBe(2);
  });
});
