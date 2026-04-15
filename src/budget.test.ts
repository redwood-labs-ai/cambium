import { describe, it, expect } from 'vitest'
import { Budget, parseBudget, trackBudgetFromTraceStep } from './budget.js'

describe('Budget', () => {
  it('passes when within limits', () => {
    const b = new Budget({ max_tokens: 1000 });
    b.addTokens(500);
    expect(b.check()).toBeNull();
  })

  it('fails when tokens exceeded', () => {
    const b = new Budget({ max_tokens: 1000 });
    b.addTokens(1001);
    const v = b.check();
    expect(v).not.toBeNull();
    expect(v!.limit).toBe('max_tokens');
    expect(v!.message).toContain('1001');
  })

  it('fails when tool calls exceeded', () => {
    const b = new Budget({ max_tool_calls: 3 });
    b.addToolCall();
    b.addToolCall();
    b.addToolCall();
    expect(b.check()).toBeNull();
    b.addToolCall();
    const v = b.check();
    expect(v).not.toBeNull();
    expect(v!.limit).toBe('max_tool_calls');
  })

  it('tracks tokens cumulatively', () => {
    const b = new Budget({ max_tokens: 100 });
    b.addTokens(30);
    b.addTokens(40);
    b.addTokens(20);
    expect(b.check()).toBeNull();
    expect(b.tokensUsed).toBe(90);
    b.addTokens(20);
    expect(b.check()).not.toBeNull();
  })

  it('produces a summary', () => {
    const b = new Budget({ max_tokens: 5000, max_tool_calls: 10 });
    b.addTokens(1234);
    b.addToolCall();
    const s = b.summary();
    expect(s.tokens.used).toBe(1234);
    expect(s.tokens.max).toBe(5000);
    expect(s.tool_calls.used).toBe(1);
  })

  it('passes with no limits set', () => {
    const b = new Budget({});
    b.addTokens(999999);
    b.addToolCall();
    expect(b.check()).toBeNull();
  })
})

describe('parseBudget (legacy constraints.budget shape)', () => {
  it('parses max_tokens from constraints.budget', () => {
    const b = parseBudget({ constraints: { budget: { max_tokens: 5000 } } });
    expect(b.limits.max_tokens).toBe(5000);
  })

  it('parses max_duration with minutes', () => {
    const b = parseBudget({ constraints: { budget: { max_duration: '5m' } } });
    expect(b.limits.max_duration_ms).toBe(300_000);
  })

  it('parses max_duration with seconds', () => {
    const b = parseBudget({ constraints: { budget: { max_duration: '30s' } } });
    expect(b.limits.max_duration_ms).toBe(30_000);
  })

  it('parses max_duration with hours', () => {
    const b = parseBudget({ constraints: { budget: { max_duration: '1h' } } });
    expect(b.limits.max_duration_ms).toBe(3600_000);
  })

  it('parses max_tool_calls from legacy constraints', () => {
    const b = parseBudget({ constraints: { budget: { max_tool_calls: 4 } } });
    expect(b.limits.max_tool_calls).toBe(4);
  })

  it('returns unlimited budget when no constraints', () => {
    const b = parseBudget({});
    expect(b.limits.max_tokens).toBeUndefined();
    expect(b.limits.max_tool_calls).toBeUndefined();
    expect(b.limits.max_duration_ms).toBeUndefined();
  })
})

describe('parseBudget (new policies.budget shape)', () => {
  it('parses per_run.max_calls into max_tool_calls', () => {
    const b = parseBudget({ budget: { per_run: { max_calls: 100 } } });
    expect(b.limits.max_tool_calls).toBe(100);
  })

  it('parses per_tool limits', () => {
    const b = parseBudget({
      budget: {
        per_tool: {
          tavily: { max_calls: 5, max_bytes: 2_000_000 },
          linear: { max_calls: 20 },
        },
      },
    });
    expect(b.perTool.tavily).toEqual({ max_calls: 5, max_bytes: 2_000_000 });
    expect(b.perTool.linear).toEqual({ max_calls: 20, max_bytes: undefined });
  })

  it('per_run.max_tool_calls alias also works', () => {
    const b = parseBudget({ budget: { per_run: { max_tool_calls: 50 } } });
    expect(b.limits.max_tool_calls).toBe(50);
  })
})

describe('Budget per-tool gating', () => {
  it('checkBeforeCall blocks the call that would exceed max_calls', () => {
    const b = new Budget({}, { tavily: { max_calls: 2 } });
    b.addToolCall('tavily');
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('tavily')).not.toBeNull();
  })

  it('checkBeforeCall allows calls up to the limit', () => {
    const b = new Budget({}, { tavily: { max_calls: 3 } });
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('tavily')).toBeNull();
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('tavily')).toBeNull();
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('tavily')).not.toBeNull();
  })

  it('checkBeforeCall blocks when bytes would exceed max_bytes', () => {
    const b = new Budget({}, { tavily: { max_bytes: 1000 } });
    b.addBytes('tavily', 900);
    expect(b.checkBeforeCall('tavily', { bytes: 50 })).toBeNull();
    expect(b.checkBeforeCall('tavily', { bytes: 200 })).not.toBeNull();
  })

  it('per-tool violation names the tool and metric', () => {
    const b = new Budget({}, { tavily: { max_calls: 1 } });
    b.addToolCall('tavily');
    const v = b.checkBeforeCall('tavily');
    expect(v?.tool).toBe('tavily');
    expect(v?.limit).toBe('max_calls');
    expect(v?.message).toContain('tavily');
  })

  it('does not cross-contaminate between tools', () => {
    const b = new Budget({}, { tavily: { max_calls: 1 }, linear: { max_calls: 5 } });
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('linear')).toBeNull();
    expect(b.checkBeforeCall('tavily')).not.toBeNull();
  })

  it('per-run max_tool_calls still gates across all tools', () => {
    const b = new Budget({ max_tool_calls: 2 }, { tavily: { max_calls: 10 } });
    b.addToolCall('tavily');
    b.addToolCall('tavily');
    expect(b.checkBeforeCall('tavily')?.limit).toBe('max_tool_calls');
  })

  it('summary includes per-tool usage', () => {
    const b = new Budget({}, { tavily: { max_calls: 5, max_bytes: 10_000 } });
    b.addToolCall('tavily');
    b.addBytes('tavily', 1234);
    const s = b.summary();
    expect(s.per_tool.tavily.calls).toEqual({ used: 1, max: 5 });
    expect(s.per_tool.tavily.bytes).toEqual({ used: 1234, max: 10_000 });
  })
})

describe('trackBudgetFromTraceStep', () => {
  it('attributes ToolCall steps to the named tool', () => {
    const b = new Budget({}, { tavily: { max_calls: 2 } });
    trackBudgetFromTraceStep(b, { type: 'ToolCall', ok: true, meta: { tool: 'tavily' } });
    expect(b.getToolUsage('tavily').calls).toBe(1);
  })

  it('attributes AgenticTurn tool_calls to named tools', () => {
    const b = new Budget({}, { tavily: { max_calls: 5 }, linear: { max_calls: 5 } });
    trackBudgetFromTraceStep(b, {
      type: 'AgenticTurn',
      meta: { tool_calls: [{ tool: 'tavily' }, { function: { name: 'linear' } }] },
    });
    expect(b.getToolUsage('tavily').calls).toBe(1);
    expect(b.getToolUsage('linear').calls).toBe(1);
  })
})
