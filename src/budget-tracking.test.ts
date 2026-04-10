import { describe, it, expect } from 'vitest';
import { Budget, trackBudgetFromTraceStep } from './budget.js';

describe('budget tracking from trace steps', () => {
  it('counts tool calls from AgenticTurn meta.tool_calls', () => {
    const b = new Budget({ max_tool_calls: 10 });

    trackBudgetFromTraceStep(b, {
      type: 'AgenticTurn',
      ok: true,
      meta: {
        tool_calls: [
          { name: 'web_search', args: '{}' },
          { name: 'web_extract', args: '{}' },
        ],
        usage: { total_tokens: 100 },
      },
    });

    expect(b.toolCallsUsed).toBe(2);
    expect(b.tokensUsed).toBe(100);
  });

  it('counts tool calls from ToolCall steps', () => {
    const b = new Budget({ max_tool_calls: 10 });

    trackBudgetFromTraceStep(b, { type: 'ToolCall', ok: true, meta: { usage: { total_tokens: 5 } } });
    trackBudgetFromTraceStep(b, { type: 'ToolCall', ok: true, meta: {} });

    expect(b.toolCallsUsed).toBe(2);
    expect(b.tokensUsed).toBe(5);
  });
});
