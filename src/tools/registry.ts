import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
};

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();

  loadFromDir(dirPath: string): void {
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
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  assertAllowed(name: string, allowlist: string[]): void {
    if (!allowlist.includes(name)) {
      throw new Error(`Tool "${name}" not in policies.tools_allowed [${allowlist.join(', ')}]`);
    }
  }

  list(): string[] {
    return [...this.defs.keys()];
  }
}
