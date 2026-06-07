import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolPermissions } from './permissions.js';
import type { ToolContext } from './tool-context.js';
import type { ValidateFunction } from 'ajv';

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
 * (`.tool.ts` / `.tool.js`) for every tool. A tool lives as a paired
 * set of files in the same directory:
 *
 *   my_tool.tool.json   — schema + permissions
 *   my_tool.tool.ts     — handler exporting `execute(input, ctx?)`
 *
 * Framework-builtin tools (calculator, read_file, web_search, etc.) live
 * in `src/builtin-tools/`. App-supplied plugin tools live in
 * `packages/<pkg>/app/tools/`. The runner calls `loadFromDir` on both
 * in that order — framework first, app second — and the registry's
 * Map.set overwrites on name collision, so an app tool automatically
 * shadows a framework builtin with the same name (RED-221 override hook).
 */
export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();
  private handlers = new Map<string, ToolHandler>();
  private inputValidators = new Map<string, ValidateFunction>();
  private _ajv: any = null;

  async loadFromDir(dirPath: string): Promise<void> {
    // AUD-007: compile input validators at registration. Lazy-init AJV on the
    // first loadFromDir call (dynamic import keeps the module load cost out of
    // the cold path for callers that never load tools).
    if (!this._ajv) {
      const AjvMod = await import('ajv');
      const Ajv = AjvMod.default ?? AjvMod;
      this._ajv = new Ajv({ allErrors: true, strict: false });
    }

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
      // Compile the input validator. A schema-compilation failure degrades to
      // no-validation for that tool (same as pre-AUD-007 baseline). Warn so
      // tool authors discover malformed schemas at dev time rather than silently.
      try {
        this.inputValidators.set(def.name, this._ajv.compile(def.inputSchema) as ValidateFunction);
      } catch (err: any) {
        process.stderr.write(
          `[cambium] WARNING: tool "${def.name}" inputSchema failed AJV compilation — ` +
          `input will not be validated: ${err?.message ?? String(err)}\n`,
        );
      }

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

  /** AJV-compiled validator for the tool's inputSchema, or undefined if the
   *  schema couldn't be compiled (safe fallback — no validation rather than crash). */
  getInputValidator(name: string): ValidateFunction | undefined {
    return this.inputValidators.get(name);
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
