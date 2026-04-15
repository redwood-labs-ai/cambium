export type BudgetLimits = {
  max_tokens?: number;
  max_tool_calls?: number;
  max_duration_ms?: number;
};

export type PerToolLimits = {
  max_calls?: number;
};

export type BudgetState = {
  tokens_used: number;
  tool_calls_used: number;
  started_at: number;
};

export type PerToolState = {
  calls: number;
};

export type BudgetViolation = {
  limit: string;
  used: number;
  max: number;
  message: string;
  tool?: string;    // set when the violation is per-tool
};

export class Budget {
  readonly limits: BudgetLimits;
  readonly perTool: Record<string, PerToolLimits>;
  private state: BudgetState;
  private perToolState: Record<string, PerToolState>;

  constructor(limits: BudgetLimits, perTool: Record<string, PerToolLimits> = {}) {
    this.limits = limits;
    this.perTool = perTool;
    this.state = { tokens_used: 0, tool_calls_used: 0, started_at: Date.now() };
    this.perToolState = {};
  }

  addTokens(count: number): void {
    this.state.tokens_used += count;
  }

  /**
   * Record a single tool invocation.
   * Increments both the per-run `tool_calls_used` counter and the per-tool
   * `calls` counter so both limits are checked on the same event.
   */
  addToolCall(tool?: string): void {
    this.state.tool_calls_used += 1;
    if (tool) this.ensureToolState(tool).calls += 1;
  }

  private ensureToolState(tool: string): PerToolState {
    let s = this.perToolState[tool];
    if (!s) {
      s = { calls: 0 };
      this.perToolState[tool] = s;
    }
    return s;
  }

  get tokensUsed(): number { return this.state.tokens_used; }
  get toolCallsUsed(): number { return this.state.tool_calls_used; }
  get elapsedMs(): number { return Date.now() - this.state.started_at; }
  getToolUsage(tool: string): PerToolState { return { ...this.ensureToolState(tool) }; }

  /**
   * Pre-call gate. Call before dispatching `tool` to see whether the
   * *next* invocation would push us over any per-tool or per-run limit.
   * Returns a violation if so, or null.
   *
   * Use this to refuse the call before spending the time, rather than
   * learning about it in `check()` after the damage is done.
   */
  checkBeforeCall(tool: string, increment: { calls?: number } = {}): BudgetViolation | null {
    const addCalls = increment.calls ?? 1;
    const perTool = this.perTool[tool];
    const state = this.ensureToolState(tool);

    if (perTool?.max_calls != null && state.calls + addCalls > perTool.max_calls) {
      return {
        limit: 'max_calls',
        tool,
        used: state.calls,
        max: perTool.max_calls,
        message: `Per-tool call budget exceeded for "${tool}": ${state.calls + addCalls} > ${perTool.max_calls}`,
      };
    }
    if (this.limits.max_tool_calls != null && this.state.tool_calls_used + addCalls > this.limits.max_tool_calls) {
      return {
        limit: 'max_tool_calls',
        used: this.state.tool_calls_used,
        max: this.limits.max_tool_calls,
        message: `Per-run tool call budget exceeded: ${this.state.tool_calls_used + addCalls} > ${this.limits.max_tool_calls}`,
      };
    }
    return null;
  }

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

    // Per-tool: did any tool exceed its limits cumulatively? (belt-and-suspenders
    // — checkBeforeCall is the primary gate; this covers anyone who skipped it.)
    for (const [tool, limits] of Object.entries(this.perTool)) {
      const s = this.perToolState[tool];
      if (!s) continue;
      if (limits.max_calls != null && s.calls > limits.max_calls) {
        return {
          limit: 'max_calls', tool, used: s.calls, max: limits.max_calls,
          message: `Per-tool call budget exceeded for "${tool}": ${s.calls} / ${limits.max_calls}`,
        };
      }
    }

    return null;
  }

  /** Summary for trace output */
  summary(): Record<string, any> {
    const perTool: Record<string, any> = {};
    for (const [tool, state] of Object.entries(this.perToolState)) {
      const limits = this.perTool[tool];
      perTool[tool] = {
        calls: { used: state.calls, max: limits?.max_calls ?? 'unlimited' },
      };
    }
    return {
      tokens: { used: this.state.tokens_used, max: this.limits.max_tokens ?? 'unlimited' },
      tool_calls: { used: this.state.tool_calls_used, max: this.limits.max_tool_calls ?? 'unlimited' },
      duration_ms: { used: this.elapsedMs, max: this.limits.max_duration_ms ?? 'unlimited' },
      per_tool: perTool,
    };
  }
}

/**
 * Apply usage + tool-call accounting from a trace step.
 *
 * - Adds tokens from step.meta.usage.total_tokens when present.
 * - Increments tool calls for:
 *   - ToolCall steps (1, tagged with step.meta.tool)
 *   - AgenticTurn steps (meta.tool_calls.length)
 */
export function trackBudgetFromTraceStep(budget: Budget, step: any): void {
  const usage = step?.meta?.usage;
  if (usage?.total_tokens) budget.addTokens(usage.total_tokens);

  if (step?.type === 'ToolCall' && step?.ok) {
    budget.addToolCall(step?.meta?.tool);
  }

  if (step?.type === 'AgenticTurn') {
    const calls = Array.isArray(step?.meta?.tool_calls) ? step.meta.tool_calls : [];
    for (const c of calls) {
      // Tool name may live under c.tool or c.function.name depending on turn shape.
      const name = c?.tool ?? c?.function?.name;
      budget.addToolCall(name);
    }
  }
}

/**
 * Parse budget from IR policies.
 *
 * Reads the new top-level `policies.budget` (RED-137) shape:
 *   { per_tool: { tavily: { max_calls, max_bytes } }, per_run: { max_calls } }
 *
 * Also reads the legacy `policies.constraints.budget` shape for any gen
 * that still declares `constrain :budget, max_tool_calls: N, max_duration: "5m"`.
 * Legacy max_tokens / max_tool_calls / max_duration land on per-run limits;
 * if both are present, top-level wins per-metric.
 */
export function parseBudget(policies: any): Budget {
  const legacy = policies?.budget ?? policies?.constraints?.budget ?? {};
  const top = policies?.budget ?? null;
  const isTopLevel = top && (top.per_tool || top.per_run);

  let maxDurationMs: number | undefined;
  const legacyDuration = legacy?.max_duration;
  if (legacyDuration) {
    const m = String(legacyDuration).match(/^(\d+)(s|m|h)$/);
    if (m) {
      const val = Number(m[1]);
      const unit = m[2];
      maxDurationMs = unit === 's' ? val * 1000 : unit === 'm' ? val * 60_000 : val * 3600_000;
    }
  }

  const perRun = isTopLevel ? (top.per_run ?? {}) : {};
  const perTool = isTopLevel ? (top.per_tool ?? {}) : {};

  const runLimits: BudgetLimits = {
    max_tokens:      perRun.max_tokens      ?? (legacy.max_tokens      != null ? Number(legacy.max_tokens)      : undefined),
    max_tool_calls:  perRun.max_calls       ?? perRun.max_tool_calls   ?? (legacy.max_tool_calls  != null ? Number(legacy.max_tool_calls)  : undefined),
    max_duration_ms: maxDurationMs,
  };

  const perToolLimits: Record<string, PerToolLimits> = {};
  for (const [tool, limits] of Object.entries(perTool) as [string, any][]) {
    perToolLimits[tool] = {
      max_calls: limits?.max_calls != null ? Number(limits.max_calls) : undefined,
    };
  }

  return new Budget(runLimits, perToolLimits);
}
