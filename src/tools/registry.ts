import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolPermissions } from './permissions.js';
import type { ToolContext } from './tool-context.js';

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  permissions?: ToolPermissions;
};

export type ToolHandler = (input: any, ctx?: ToolContext) => any;

/**
 * ToolRegistry owns both the schemas (`.tool.json`) and the handlers
 * (`.tool.ts` / `.tool.js`) for plugin tools. A plugin tool lives as a
 * paired set of files in the same directory:
 *
 *   my_tool.tool.json   — schema + permissions (already here)
 *   my_tool.tool.ts     — handler exporting `execute(input, ctx?)`
 *
 * The registry auto-discovers both. Framework-builtin tools (calculator,
 * read_file, etc.) continue to live in `src/tools/` and get looked up
 * via the `builtinTools` map as a fallback; when a plugin and a builtin
 * share a name, the plugin wins (app code overrides the framework).
 */
export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  private handlers = new Map<string, ToolHandler>();

  async loadFromDir(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return; // no tools dir is fine
    }

    for (const f of entries) {
      if (!f.endsWith('.tool.json')) continue;
      const raw = readFileSync(join(dirPath, f), 'utf8');
      const def: ToolDefinition = JSON.parse(raw);
      if (!def.name || !def.inputSchema || !def.outputSchema) {
        throw new Error(`Invalid tool definition in ${f}: missing name, inputSchema, or outputSchema`);
      }
      this.defs.set(def.name, def);

      // RED-209: look for a sibling handler module. Prefer .tool.ts for
      // dev (the CLI and vitest both load tsx); fall back to .tool.js
      // for environments without a TS loader. Absence is fine — a
      // builtin-tools fallback will resolve the handler at dispatch.
      const base = f.slice(0, -'.tool.json'.length);
      const handlerCandidates = [
        join(dirPath, `${base}.tool.ts`),
        join(dirPath, `${base}.tool.js`),
      ];
      const handlerFile = handlerCandidates.find(p => existsSync(p));
      if (handlerFile) {
        const mod = await import(pathToFileURL(handlerFile).href);
        if (typeof mod.execute !== 'function') {
          throw new Error(
            `Plugin tool "${def.name}" handler at ${handlerFile} must export an 'execute' function`,
          );
        }
        this.handlers.set(def.name, mod.execute as ToolHandler);
      }
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  /** Handler registered by a plugin tool (not a framework builtin). */
  getHandler(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  assertAllowed(name: string, allowlist: string[]): void {
    if (!allowlist.includes(name)) {
      throw new Error(`Tool "${name}" not in policies.tools_allowed [${allowlist.join(', ')}]`);
    }
  }

  list(): string[] {
    return [...this.defs.keys()];
  }

  /**
   * Convert tool definitions to OpenAI function-calling format.
   * Only includes tools in the allowlist.
   */
  toOpenAIFormat(allowlist: string[]): any[] {
    const tools: any[] = [];
    for (const name of allowlist) {
      const def = this.defs.get(name);
      if (!def) continue;
      tools.push({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: def.inputSchema,
        },
      });
    }
    return tools;
  }
}
