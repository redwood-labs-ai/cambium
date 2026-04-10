import { describe, it, expect } from 'vitest'
import { Budget, parseBudget } from './budget.js'

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

describe('parseBudget', () => {
  it('parses max_tokens from constraints', () => {
    const b = parseBudget({ budget: { max_tokens: 5000 } });
    expect(b.limits.max_tokens).toBe(5000);
  })

  it('parses max_duration with minutes', () => {
    const b = parseBudget({ budget: { max_duration: '5m' } });
    expect(b.limits.max_duration_ms).toBe(300_000);
  })

  it('parses max_duration with seconds', () => {
    const b = parseBudget({ budget: { max_duration: '30s' } });
    expect(b.limits.max_duration_ms).toBe(30_000);
  })

  it('parses max_duration with hours', () => {
    const b = parseBudget({ budget: { max_duration: '1h' } });
    expect(b.limits.max_duration_ms).toBe(3600_000);
  })

  it('returns unlimited budget when no constraints', () => {
    const b = parseBudget({});
    expect(b.limits.max_tokens).toBeUndefined();
    expect(b.limits.max_tool_calls).toBeUndefined();
    expect(b.limits.max_duration_ms).toBeUndefined();
  })
})
