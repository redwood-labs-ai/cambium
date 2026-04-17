import type { SignalState } from './signals.js';
import { ToolRegistry } from './tools/registry.js';
import { handleToolCall, type ToolCallEnv } from './step-handlers.js';
import { ActionRegistry } from './actions/registry.js';
import { buildToolContext } from './tools/tool-context.js';

/**
 * Trigger shapes — discriminated on `action`:
 *   { action: "tool_call",   tool: <name>, args, target? }
 *   { action: "action_call", name: <name>, args, target? }   // RED-212
 */
export type TriggerDef = {
  on: string;
  action: string;
  /** Present when action === "tool_call". */
  tool?: string;
  /** Present when action === "action_call". */
  name?: string;
  args: Record<string, any>;
  target?: string;
};

export type TriggerResult = {
  fired: boolean;
  target?: string;
  value?: any;
  traceEntry: Record<string, any>;
};

/**
 * Evaluate triggers against extracted signal state.
 * For each trigger whose signal has values, fire the declared action.
 *
 * `actionRegistry` is optional for back-compat with callers that
 * pre-date RED-212 (e.g. unit tests constructed before the param
 * existed). When absent, `action_call` triggers are skipped with a
 * traced reason. Production callers (runner.ts) always pass one.
 */
export async function evaluateTriggers(
  triggers: TriggerDef[],
  state: SignalState,
  toolRegistry: ToolRegistry,
  toolsAllowed: string[],
  env: ToolCallEnv = {},
  actionRegistry?: ActionRegistry,
): Promise<TriggerResult[]> {
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

      const tcResult = await handleToolCall(
        trigger.tool!,
        toolInput.operation ?? 'unknown',
        toolInput,
        toolRegistry,
        toolsAllowed,
        env,
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
    } else if (trigger.action === 'action_call') {
      // RED-212: custom action handler dispatch. Mirrors handleToolCall
      // in the two things that matter for threat model — budget gate
      // first, then ctx construction bound to the gen's network policy.
      // Actions do NOT go through the tool allowlist (authors declare
      // actions inline in triggers; there's no runtime choice a model
      // could make to escape the allowlist).
      const handled = await dispatchAction(
        trigger, signalValue, actionRegistry, env,
      );
      results.push(handled);
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

async function dispatchAction(
  trigger: TriggerDef,
  signalValue: any,
  actionRegistry: ActionRegistry | undefined,
  env: ToolCallEnv,
): Promise<TriggerResult> {
  const actionName = trigger.name!;
  if (!actionRegistry) {
    return {
      fired: false,
      traceEntry: {
        type: 'TriggerSkipped',
        ok: false,
        meta: {
          on: trigger.on,
          reason: `action_call trigger '${actionName}' skipped — no ActionRegistry provided`,
        },
      },
    };
  }

  const def = actionRegistry.get(actionName);
  const handler = actionRegistry.getHandler(actionName);
  if (!def || !handler) {
    return {
      fired: false,
      traceEntry: {
        type: 'ActionCall',
        id: `action_${actionName}`,
        ok: false,
        errors: [{
          message: `action '${actionName}' not found in registry. Available: [${actionRegistry.list().join(', ')}]`,
        }],
        meta: { trigger: trigger.on, action: actionName },
      },
    };
  }

  // RED-212: budget check BEFORE invocation, mirroring handleToolCall's
  // ordering (invariants #8, #23). checkBeforeCall returns a violation
  // object or null; it does NOT throw. Actions count toward per_run but
  // not per_tool (see addToolCall() below — no tool name passed).
  const violation = env.budget?.checkBeforeCall?.(actionName);
  if (violation) {
    if (env.traceEvents) {
      env.traceEvents.push({
        type: 'tool.budget.exceeded',
        id: `action_budget_${actionName}`,
        ok: false,
        meta: { surface: 'action', action: actionName, ...violation },
      });
    }
    return {
      fired: false,
      traceEntry: {
        type: 'ActionCall',
        id: `action_${actionName}`,
        ok: false,
        errors: [{ message: violation.message }],
        meta: { trigger: trigger.on, action: actionName, budget: violation },
      },
    };
  }

  // Build input — include the signal value so actions can reference it
  // under `operands` (like tools) or as the raw `signalValue` field.
  const input: Record<string, any> = { ...trigger.args };
  if (!('operands' in input)) {
    if (Array.isArray(signalValue)) input.operands = signalValue;
    else if (signalValue !== undefined) input.operands = [signalValue];
  }
  input.signalValue = signalValue;

  // buildToolContext expects a NetworkPolicy, not a SecurityPolicy.
  // Mirrors how handleToolCall passes env.policy?.network at step-
  // handlers.ts. Getting this wrong would silently hand guardedFetch
  // a shape-mismatched object (no allowlist/denylist fields present)
  // and bypass SSRF entirely — caught by cambium-security review.
  // execPolicy threads through for action handlers that might dispatch
  // exec (unlikely but possible; mirrors step-handlers.ts).
  const ctx = buildToolContext({
    toolName: actionName,
    policy: env.policy?.network,
    execPolicy: env.policy?.exec,
    emitStep: env.traceEvents ? (step) => env.traceEvents!.push(step) : undefined,
  });

  const start = Date.now();
  try {
    const output = await handler(input, ctx);
    const ms = Date.now() - start;
    // Count toward per_run only — pass no tool name so
    // `perToolState[name]` is not incremented. Actions are a distinct
    // surface from tools for budget purposes.
    env.budget?.addToolCall?.();
    return {
      fired: true,
      target: trigger.target,
      value: output?.value,
      traceEntry: {
        type: 'ActionCall',
        id: `action_${actionName}`,
        ok: true,
        ms,
        meta: {
          trigger: trigger.on,
          action: actionName,
          input,
          output,
          target: trigger.target,
        },
      },
    };
  } catch (e: any) {
    // Mirror handleToolCall's permission-denied trace emission. A
    // guardedFetch rejection attaches a `guardDecision` to the error;
    // structured traces are the audit log — losing them is a
    // regression on invariant #11 for action dispatch.
    if (e?.guardDecision && env.traceEvents) {
      const g = e.guardDecision;
      env.traceEvents.push({
        type: 'tool.permission.denied',
        id: `action_denied_${actionName}`,
        ok: false,
        meta: {
          surface: 'action',
          action: actionName,
          host: g.host,
          reason: g.reason,
          rule: g.rule,
          resolved_ips: g.resolved_ips,
        },
      });
    }
    return {
      fired: false,
      traceEntry: {
        type: 'ActionCall',
        id: `action_${actionName}`,
        ok: false,
        ms: Date.now() - start,
        errors: [{ message: String(e?.message ?? e) }],
        meta: { trigger: trigger.on, action: actionName, input },
      },
    };
  }
}
