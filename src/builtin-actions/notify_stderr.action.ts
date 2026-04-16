import type { ToolContext } from '../tools/tool-context.js';

/**
 * RED-212 reference action: write a single line to stderr.
 *
 * Purely a demo / template — no network, no filesystem, no exec.
 * Useful for local runs when you want a trigger to produce visible
 * output without wiring up a real integration. Real notification
 * actions (webhook, Slack, Linear) follow the same handler shape;
 * they just add `ctx.fetch` calls and declare `network_hosts` in
 * their .action.json.
 */
export function execute(input: any, _ctx?: ToolContext): { value: string } {
  const prefix = typeof input?.prefix === 'string'
    ? input.prefix
    : '[cambium:action:notify_stderr]';
  const message = typeof input?.message === 'string'
    ? input.message
    : stringifyForLog(input);
  const line = `${prefix} ${message}`;
  process.stderr.write(line + '\n');
  return { value: line };
}

function stringifyForLog(input: any): string {
  // Triggers pass the signal value in under various keys depending on
  // how the trigger DSL was written. Surface the most useful summary
  // without dumping the whole object blob on the console.
  if (input == null) return '(no input)';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input?.operands)) return `operands=[${input.operands.join(',')}]`;
  try {
    return JSON.stringify(input);
  } catch {
    return '(unstringifiable input)';
  }
}
