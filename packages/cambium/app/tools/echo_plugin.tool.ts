/**
 * Proof-of-concept plugin tool (RED-209).
 *
 * Lives alongside its schema (`echo_plugin.tool.json`). The ToolRegistry
 * auto-discovers both at load time — no edits to src/tools/index.ts.
 *
 * Exports a single `execute(input, ctx?)` function matching the shape
 * framework builtins use.
 */

import type { ToolContext } from '../../../../src/tools/tool-context.js';

export async function execute(
  input: { message: string },
  _ctx?: ToolContext,
): Promise<{ echoed: string }> {
  return { echoed: input.message };
}
