/**
 * Post-RED-221 this module is nearly empty — framework-builtin tool
 * handlers used to live here in a hardcoded map. They've moved to
 * `src/builtin-tools/` as paired .tool.json + .tool.ts files that the
 * registry auto-discovers the same way it discovers app-supplied
 * plugin tools.
 *
 * A tiny ad-hoc override map remains for tests that need to shim a
 * handler without writing a fixture file. Dispatch uses this map only
 * when the registry has no handler for the name — normal tools should
 * never rely on it.
 */

import type { ToolContext } from './tool-context.js';

export const testOverrideHandlers: Record<string, (input: any, ctx?: ToolContext) => any> = {};
