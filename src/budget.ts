export type BudgetLimits = {
  max_tokens?: number;
  max_tool_calls?: number;
  max_duration_ms?: number;
};

export type BudgetState = {
  tokens_used: number;
  tool_calls_used: number;
  started_at: number;
};

export type BudgetViolation = {
  limit: string;
  used: number;
  max: number;
  message: string;
};

export class Budget {
  readonly limits: BudgetLimits;
  private state: BudgetState;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
    this.state = { tokens_used: 0, tool_calls_used: 0, started_at: Date.now() };
  }

  addTokens(count: number): void {
    this.state.tokens_used += count;
  }

  addToolCall(): void {
    this.state.tool_calls_used += 1;
  }

  get tokensUsed(): number { return this.state.tokens_used; }
  get toolCallsUsed(): number { return this.state.tool_calls_used; }
  get elapsedMs(): number { return Date.now() - this.state.started_at; }

  /**
   * Check if any budget limit has been exceeded.
   * Returns null if within budget, or a BudgetViolation if exceeded.
   */
  check(): BudgetViolation | null {
    if (this.limits.max_tokens != null && this.state.tokens_used > this.limits.max_tokens) {
      return {
        limit: 'max_tokens',
        used: this.state.tokens_used,
        max: this.limits.max_tokens,
        message: `Token budget exceeded: ${this.state.tokens_used} / ${this.limits.max_tokens}`,
      };
    }

    if (this.limits.max_tool_calls != null && this.state.tool_calls_used > this.limits.max_tool_calls) {
      return {
        limit: 'max_tool_calls',
        used: this.state.tool_calls_used,
        max: this.limits.max_tool_calls,
        message: `Tool call budget exceeded: ${this.state.tool_calls_used} / ${this.limits.max_tool_calls}`,
      };
    }

    if (this.limits.max_duration_ms != null && this.elapsedMs > this.limits.max_duration_ms) {
      return {
        limit: 'max_duration',
        used: this.elapsedMs,
        max: this.limits.max_duration_ms,
        message: `Duration budget exceeded: ${Math.round(this.elapsedMs / 1000)}s / ${Math.round(this.limits.max_duration_ms / 1000)}s`,
      };
    }

    return null;
  }

  /** Summary for trace output */
  summary(): Record<string, any> {
    return {
      tokens: { used: this.state.tokens_used, max: this.limits.max_tokens ?? 'unlimited' },
      tool_calls: { used: this.state.tool_calls_used, max: this.limits.max_tool_calls ?? 'unlimited' },
      duration_ms: { used: this.elapsedMs, max: this.limits.max_duration_ms ?? 'unlimited' },
    };
  }
}

/**
 * Apply usage + tool-call accounting from a trace step.
 *
 * - Adds tokens from step.meta.usage.total_tokens when present.
 * - Increments tool calls for:
 *   - ToolCall steps (1)
 *   - AgenticTurn steps (meta.tool_calls.length)
 */
export function trackBudgetFromTraceStep(budget: Budget, step: any): void {
  const usage = step?.meta?.usage;
  if (usage?.total_tokens) budget.addTokens(usage.total_tokens);

  if (step?.type === 'ToolCall' && step?.ok) {
    budget.addToolCall();
  }

  if (step?.type === 'AgenticTurn') {
    const n = Array.isArray(step?.meta?.tool_calls) ? step.meta.tool_calls.length : 0;
    for (let i = 0; i < n; i++) budget.addToolCall();
  }
}

/**
 * Parse budget constraints from IR policies.
 * Supports: constrain :budget, max_tokens: N, max_tool_calls: N, max_duration: "5m"
 */
export function parseBudget(constraints: any): Budget {
  const budgetConfig = constraints?.budget ?? {};

  let maxDurationMs: number | undefined;
  if (budgetConfig.max_duration) {
    const dur = String(budgetConfig.max_duration);
    const m = dur.match(/^(\d+)(s|m|h)$/);
    if (m) {
      const val = Number(m[1]);
      const unit = m[2];
      maxDurationMs = unit === 's' ? val * 1000 : unit === 'm' ? val * 60_000 : val * 3600_000;
    }
  }

  return new Budget({
    max_tokens: budgetConfig.max_tokens != null ? Number(budgetConfig.max_tokens) : undefined,
    max_tool_calls: budgetConfig.max_tool_calls != null ? Number(budgetConfig.max_tool_calls) : undefined,
    max_duration_ms: maxDurationMs,
  });
}
