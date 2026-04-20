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

  // RED-280: every repair-step push in runGen now goes through
  // `pushRepairStep(repair)` which calls `budgetTrack(repair.result)`.
  // The outcome we actually care about is that Repair-step token usage
  // feeds the budget, regardless of which repair site (schema, Review,
  // Consensus, corrector feedback, grounding) produced it. This unit
  // test locks that invariant.
  it('counts tokens from Repair steps regardless of repair site (RED-280)', () => {
    const b = new Budget({ max_tokens: 1000 });

    // Schema-repair loop
    trackBudgetFromTraceStep(b, { type: 'Repair', ok: true, meta: { usage: { total_tokens: 50 } } });
    // Review repair
    trackBudgetFromTraceStep(b, { type: 'Repair', ok: true, meta: { usage: { total_tokens: 60 } } });
    // Consensus repair — previously bare-pushed without budget tracking
    trackBudgetFromTraceStep(b, { type: 'Repair', ok: true, meta: { usage: { total_tokens: 70 } } });
    // Corrector-feedback repair
    trackBudgetFromTraceStep(b, { type: 'Repair', ok: true, meta: { usage: { total_tokens: 80 } } });
    // Grounding repair — previously bare-pushed without budget tracking
    trackBudgetFromTraceStep(b, { type: 'Repair', ok: true, meta: { usage: { total_tokens: 90 } } });

    expect(b.tokensUsed).toBe(350);
  });
});
