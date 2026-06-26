// RED-393: provider registry + authoring helpers.
//
// The runner builds a ProviderRegistry at startup: framework built-ins
// first (anthropic/omlx/ollama), then app-supplied `app/providers/*.ts`
// shadowing built-ins on name collision (same precedence as tools).
// Dispatch resolves the model-id prefix to a registered provider.
//
// `loadFromDir` (app/providers discovery) mirrors ToolRegistry: each file
// `app/providers/<name>.ts` `export default`s a CambiumProvider whose name
// derives from the filename (= model-id prefix). App providers register after
// the built-ins so a same-named app provider shadows a built-in.

import { readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CambiumProvider } from './types.js';

/**
 * Model-name transform: maps Cambium's prefix-stripped model name to the
 * id the provider's API actually wants in the request body. Accepts either
 * a function or — sugar for the common Azure/deployment case — a plain
 * object map. Unmapped keys pass through unchanged.
 *
 *   modelName: (n) => n.includes('/') ? n : `anthropic/${n}`   // openrouter
 *   modelName: { 'gpt-4o': 'my-prod-deploy' }                  // azure
 */
export type ModelNameTransform = ((name: string) => string) | Record<string, string>;

/** Normalize a ModelNameTransform (or undefined) to a function. Default is
 *  identity — most providers take the name verbatim. */
export function normalizeModelName(
  transform: ModelNameTransform | undefined,
): (name: string) => string {
  if (!transform) return (n) => n;
  if (typeof transform === 'function') return transform;
  return (n) => transform[n] ?? n;
}

/**
 * Identity helper for authoring a full custom provider (the Tier-2 escape
 * hatch), à la Vite's `defineConfig`: no magic, just type inference.
 *
 *   export default defineProvider({ name: 'weird', supportsDocuments: false,
 *     async generateText(opts) { ... }, async generateWithTools(opts) { ... } })
 */
export function defineProvider(provider: CambiumProvider): CambiumProvider {
  return provider;
}

export class ProviderRegistry {
  private providers = new Map<string, CambiumProvider>();

  /** Register a provider. A later registration with the same `name` wins —
   *  this is the app-shadows-builtin override hook (load built-ins first,
   *  app providers second). */
  register(provider: CambiumProvider): void {
    this.providers.set(provider.name, provider);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  get(name: string): CambiumProvider | undefined {
    return this.providers.get(name);
  }

  /** Registered provider names (for error messages: "unknown provider X;
   *  known: [...]"). */
  names(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Discover app-supplied providers under `dirPath` (`app/providers/`).
   * Each `<name>.ts` (or compiled `<name>.js`) `export default`s a
   * `CambiumProvider`; the basename becomes the model-id prefix. A missing
   * directory is fine (most apps ship none). Called AFTER the built-ins are
   * registered, so an app provider shadows a same-named built-in.
   *
   * Guards (mirroring RED-214 pack names / RED-275 app correctors):
   *   - basename must match /^[a-z][a-z0-9_]*$/ — it becomes the model-id
   *     prefix AND is interpolated into a filesystem path.
   *   - realpath escape check rejects a symlink that resolves outside dirPath.
   *   - `export default` must be an object implementing both generate methods.
   *   - if the provider carries a `name`, it must equal the basename (honesty;
   *     same stance as app correctors' export-name match).
   */
  async loadFromDir(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return; // no app/providers dir is fine
    }

    // Collect module basenames, preferring `.ts` over a compiled `.js` for the
    // same name. Skip declaration and test files so a stray `*.test.ts` in the
    // dir isn't imported as a provider.
    const bases = new Map<string, string>(); // base → filename
    for (const f of entries) {
      if (f.endsWith('.d.ts') || f.endsWith('.test.ts') || f.endsWith('.test.js')) continue;
      let base: string | undefined;
      if (f.endsWith('.ts')) base = f.slice(0, -3);
      else if (f.endsWith('.js')) base = f.slice(0, -3);
      else continue;
      const existing = bases.get(base);
      if (!existing || (f.endsWith('.ts') && !existing.endsWith('.ts'))) bases.set(base, f);
    }

    if (bases.size === 0) return;
    // Resolve the dir's realpath for the escape check. Guard it the same way
    // the readdir above is guarded: if the directory vanished between readdir
    // and here (symlink swap, transient FS event), treat it as absent rather
    // than crashing runGen startup — parity with app-loader's existsSync gate.
    let realDir: string;
    try {
      realDir = realpathSync(dirPath);
    } catch {
      return;
    }
    for (const [base, filename] of bases) {
      if (!/^[a-z][a-z0-9_]*$/.test(base)) {
        throw new Error(
          `Invalid provider file name "${filename}": the basename becomes the model-id prefix and must match /^[a-z][a-z0-9_]*$/.`,
        );
      }
      const realFile = realpathSync(join(dirPath, filename));
      if (relative(realDir, realFile).startsWith('..')) {
        throw new Error(`Provider file "${filename}" resolves outside ${dirPath} (symlink escape).`);
      }
      const mod = await import(pathToFileURL(realFile).href);
      const provider = mod.default;
      if (!provider || typeof provider !== 'object') {
        throw new Error(`Provider module "${filename}" must \`export default\` a CambiumProvider.`);
      }
      if (typeof provider.generateText !== 'function' || typeof provider.generateWithTools !== 'function') {
        throw new Error(
          `Provider "${base}" (${filename}) must implement both generateText and generateWithTools.`,
        );
      }
      if (provider.name && provider.name !== base) {
        throw new Error(
          `Provider in "${filename}" declares name "${provider.name}" but the filename requires "${base}". ` +
          `Rename the file or drop the name field (it derives from the filename).`,
        );
      }
      this.register({
        ...provider,
        name: base,
        supportsDocuments: !!provider.supportsDocuments,
        supportsPromptCacheControl: !!provider.supportsPromptCacheControl,
      });
    }
  }
}
