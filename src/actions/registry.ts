import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolPermissions } from '../tools/permissions.js';
import type { ToolContext } from '../tools/tool-context.js';

export type ActionDefinition = {
  name: string;
  description: string;
  inputSchema: object;
  /** Output is optional — actions are side-effects by default. If an
   *  action returns a value, its shape is described here for trace
   *  readability. */
  outputSchema?: object;
  permissions?: ToolPermissions;
};

export type ActionHandler = (input: any, ctx?: ToolContext) => any;

/**
 * RED-212: ActionRegistry — parallel to ToolRegistry, but addressed
 * only by the trigger DSL's `action :name` directive, not by gens'
 * `uses :name` allowlist. An action lives as a paired set of files:
 *
 *   my_action.action.json   — schema + permissions
 *   my_action.action.ts     — handler exporting `execute(input, ctx?)`
 *
 * Framework-builtin actions live in `src/builtin-actions/`. App-
 * supplied plugin actions live in `packages/<pkg>/app/actions/`. The
 * runner calls `loadFromDir` on both in that order; name collision
 * lets an app action override a builtin (same override hook as tools).
 *
 * Actions run through the same ToolContext as tools — `ctx.fetch` is
 * bound to the gen's network policy, so any action that makes an
 * HTTP(S) request inherits the SSRF guard. They count toward the
 * gen's `per_run` budget but not `per_tool`.
 */
export class ActionRegistry {
  private defs = new Map<string, ActionDefinition>();
  private handlers = new Map<string, ActionHandler>();

  async loadFromDir(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return; // no actions dir is fine
    }

    for (const f of entries) {
      if (!f.endsWith('.action.json')) continue;
      const raw = readFileSync(join(dirPath, f), 'utf8');
      const def: ActionDefinition = JSON.parse(raw);
      if (!def.name || !def.inputSchema) {
        throw new Error(`Invalid action definition in ${f}: missing name or inputSchema`);
      }
      this.defs.set(def.name, def);

      const base = f.slice(0, -'.action.json'.length);
      const handlerCandidates = [
        join(dirPath, `${base}.action.ts`),
        join(dirPath, `${base}.action.js`),
      ];
      const handlerFile = handlerCandidates.find(p => existsSync(p));
      if (handlerFile) {
        const mod = await import(pathToFileURL(handlerFile).href);
        if (typeof mod.execute !== 'function') {
          throw new Error(
            `Action "${def.name}" handler at ${handlerFile} must export an 'execute' function`,
          );
        }
        this.handlers.set(def.name, mod.execute as ActionHandler);
      } else {
        throw new Error(
          `Action "${def.name}" has a schema at ${f} but no sibling .action.ts/.action.js handler`,
        );
      }
    }
  }

  get(name: string): ActionDefinition | undefined {
    return this.defs.get(name);
  }

  getHandler(name: string): ActionHandler | undefined {
    return this.handlers.get(name);
  }

  list(): string[] {
    return [...this.defs.keys()];
  }
}
