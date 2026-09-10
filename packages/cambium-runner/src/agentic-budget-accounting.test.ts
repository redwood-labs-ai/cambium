/**
 * A gen whose model requests several tool calls per turn must be able to run
 * to its configured max_tool_calls and finalize. It used to hard-fail with the
 * step's output discarded, because runGen charged each dispatch once in the
 * loop and again when it walked the loop's traceSteps afterwards.
 *
 * These tests reproduce runGen's post-loop walk (see `budgetTrack`) rather
 * than standing up runGen itself.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { handleAgenticGenerate } from './step-handlers.js';
import { ToolRegistry } from './tools/registry.js';
import { testOverrideHandlers } from './tools/index.js';
import { Budget, trackBudgetFromTraceStep } from './budget.js';

const BUILTINS = join(process.cwd(), 'packages/cambium-runner/src/builtin-tools');
const APP_TOOLS = join(process.cwd(), 'packages/cambium/app/tools');

const registry = new ToolRegistry();
await registry.loadFromDir(BUILTINS);
await registry.loadFromDir(APP_TOOLS);

let dispatched = 0;
(registry as any).defs.set('probe', {
  name: 'probe',
  description: 'probe tool',
  permissions: { pure: true },
  inputSchema: {},
  outputSchema: {},
});
testOverrideHandlers['probe'] = async (input: any) => {
  dispatched += 1;
  return { value: input.q };
};

(registry as any).defs.set('boom', {
  name: 'boom',
  description: 'always throws',
  permissions: { pure: true },
  inputSchema: {},
  outputSchema: {},
});
testOverrideHandlers['boom'] = async () => {
  dispatched += 1;
  throw new Error('tool exploded');
};

const SCHEMA = {
  $id: 'ProbeOut',
  type: 'object',
  properties: { answer: { type: 'string' } },
} as any;

const STEP = { prompt: 'Do the thing.' } as any;
const IR = {
  model: { id: 'test:model', max_tokens: 512, temperature: 0 },
  system: 'You are a test agent.',
  context: {},
  policies: {},
} as any;

/** Two tool calls per turn until `turnsWithCalls` is exhausted, then final JSON. */
function twoCallsPerTurn(turnsWithCalls: number) {
  let turn = 0;
  return async (opts: any) => {
    turn += 1;
    // A forced-final turn is offered no tools; answer with content, as a real
    // model would.
    const toolsOffered = (opts?.tools?.length ?? 0) > 0;
    if (toolsOffered && turn <= turnsWithCalls) {
      return {
        message: {
          content: null,
          tool_calls: [
            { id: `a${turn}`, type: 'function', function: { name: 'probe', arguments: `{"q":"a${turn}"}` } },
            { id: `b${turn}`, type: 'function', function: { name: 'probe', arguments: `{"q":"b${turn}"}` } },
          ],
        },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    return {
      message: { content: '{"answer":"done"}', tool_calls: null },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  };
}

/** What runGen does with the loop's traceSteps once it returns. */
function walkTraceSteps(budget: Budget, traceSteps: any[]) {
  for (const ts of traceSteps) {
    trackBudgetFromTraceStep(budget, ts);
    const violation = budget.check();
    if (violation) throw new Error(violation.message);
  }
}

async function run(maxCalls: number, turnsWithCalls: number, maxToolCalls: number = maxCalls) {
  dispatched = 0;
  const budget = new Budget({ max_tool_calls: maxCalls }, {});
  const toolsOpenAI = registry.toOpenAIFormat(['probe']);
  const result = await handleAgenticGenerate(
    STEP, IR, SCHEMA, toolsOpenAI, registry, ['probe'],
    twoCallsPerTurn(turnsWithCalls) as any,
    (raw: string) => JSON.parse(raw),
    maxToolCalls,
    { budget } as any,
    { documents: [], groundingTextByKey: {} } as any,
  );
  return { budget, result };
}

describe('agentic tool-call budget accounting', () => {
  it('charges each dispatched call exactly once', async () => {
    const { budget } = await run(10, 3);

    expect(dispatched).toBe(6);
    expect(budget.toolCallsUsed).toBe(6);
  });

  it('finalizes instead of throwing when a multi-call-per-turn run reaches its cap', async () => {
    // 4 turns x 2 calls = 8 dispatched against a cap of 8: legitimately AT the
    // cap, never over it.
    const { budget, result } = await run(8, 4);

    expect(dispatched).toBe(8);
    expect(budget.toolCallsUsed).toBe(8);
    expect(budget.check()).toBeNull();
    expect(result.parsed).toEqual({ answer: 'done' });

    // runGen's post-loop walk must not push an at-cap run over.
    expect(() => walkTraceSteps(budget, result.traceSteps)).not.toThrow();
    expect(budget.toolCallsUsed).toBe(8);
  });

  it('charges a failed dispatch, so a broken tool cannot be retried for free', async () => {
    dispatched = 0;
    const budget = new Budget({ max_tool_calls: 10 }, {});
    const toolsOpenAI = registry.toOpenAIFormat(['boom']);
    let turn = 0;
    const model = async (opts: any) => {
      turn += 1;
      if ((opts?.tools?.length ?? 0) > 0 && turn <= 3) {
        return {
          message: {
            content: null,
            tool_calls: [{ id: `x${turn}`, type: 'function', function: { name: 'boom', arguments: '{}' } }],
          },
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
      return {
        message: { content: '{"answer":"done"}', tool_calls: null },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    const result = await handleAgenticGenerate(
      STEP, IR, SCHEMA, toolsOpenAI, registry, ['boom'],
      model as any, (raw: string) => JSON.parse(raw), 10,
      { budget } as any, { documents: [], groundingTextByKey: {} } as any,
    );

    expect(dispatched).toBe(3);
    expect(budget.toolCallsUsed).toBe(3);
    expect(result.parsed).toEqual({ answer: 'done' });
    expect(() => walkTraceSteps(budget, result.traceSteps)).not.toThrow();
    expect(budget.toolCallsUsed).toBe(3);
  });

  it('does not charge a call the budget gate refused', async () => {
    // The budget cap (4) must be the binding constraint, not the loop's own
    // limit — pass a loop limit (10) well above it so checkBeforeCall is
    // actually consulted and actually refuses, rather than the loop's
    // totalToolCalls-vs-maxToolCalls check forcing final first.
    const { budget } = await run(4, 5, 10);

    expect(dispatched).toBe(4);
    expect(budget.toolCallsUsed).toBe(4);
  });

  it('refuses the call that would cross the cap and still returns output', async () => {
    // Model wants 10 calls, cap is 5. The pre-call gate refuses the 6th, which
    // ends the loop early and forces a final turn.
    const { budget, result } = await run(5, 5);

    expect(dispatched).toBe(5);
    expect(budget.toolCallsUsed).toBe(5);
    expect(result.parsed).toEqual({ answer: 'done' });
    expect(() => walkTraceSteps(budget, result.traceSteps)).not.toThrow();
  });
});
