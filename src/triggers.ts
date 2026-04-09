import type { SignalState } from './signals.js';
import { ToolRegistry } from './tools/registry.js';
import { handleToolCall } from './step-handlers.js';

export type TriggerDef = {
  on: string;           // signal name to watch
  action: string;       // "tool_call"
  tool: string;         // tool name
  args: Record<string, any>; // e.g. { operation: "avg" }
  target?: string;      // dot path to write result into output, e.g. "metrics.avg_latency_ms"
};

export type TriggerResult = {
  fired: boolean;
  target?: string;
  value?: any;
  traceEntry: Record<string, any>;
};

/**
 * Evaluate triggers against extracted signal state.
 * For each trigger whose signal has values, fire the action.
 */
export function evaluateTriggers(
  triggers: TriggerDef[],
  state: SignalState,
  toolRegistry: ToolRegistry,
  toolsAllowed: string[],
): TriggerResult[] {
  const results: TriggerResult[] = [];

  for (const trigger of triggers) {
    const signalValue = state[trigger.on];

    // Skip if signal has no value or is an empty array
    if (signalValue === undefined || (Array.isArray(signalValue) && signalValue.length === 0)) {
      results.push({
        fired: false,
        traceEntry: {
          type: 'TriggerSkipped',
          ok: true,
          meta: { on: trigger.on, reason: 'signal not present in state' },
        },
      });
      continue;
    }

    if (trigger.action === 'tool_call') {
      // Build tool input: merge trigger args with signal values as operands
      const toolInput: Record<string, any> = { ...trigger.args };

      // If operands aren't explicitly set, use the signal value
      if (!('operands' in toolInput)) {
        if (Array.isArray(signalValue)) {
          toolInput.operands = signalValue;
        } else if (typeof signalValue === 'number') {
          toolInput.operands = [signalValue];
        }
      }

      const tcResult = handleToolCall(
        trigger.tool,
        toolInput.operation ?? 'unknown',
        toolInput,
        toolRegistry,
        toolsAllowed,
      );

      const computedValue = tcResult.output?.value;

      results.push({
        fired: true,
        target: trigger.target,
        value: computedValue,
        traceEntry: {
          type: 'ToolCall',
          ok: tcResult.ok,
          ms: tcResult.ms,
          meta: {
            trigger: trigger.on,
            tool: trigger.tool,
            operation: toolInput.operation,
            input: toolInput,
            output: tcResult.output,
            target: trigger.target,
          },
        },
      });
    } else {
      results.push({
        fired: false,
        traceEntry: {
          type: 'TriggerSkipped',
          ok: false,
          meta: { on: trigger.on, reason: `Unknown action: ${trigger.action}` },
        },
      });
    }
  }

  return results;
}
