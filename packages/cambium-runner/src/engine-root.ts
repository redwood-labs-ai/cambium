// ── Engine-folder resolution (RED-287) ─────────────────────────────────
//
// Engine mode (RED-220, RED-246) packages a gen + its system prompt +
// tools + schemas + compiled IR into a single folder marked by a
// `cambium.engine.json` sentinel. Everything is a **sibling** of the
// gen file:
//
//   <engineDir>/summarizer.cmb.rb
//   <engineDir>/summarizer.system.md
//   <engineDir>/price_fetcher.tool.{json,ts}
//   <engineDir>/summarizer.ir.json
//   <engineDir>/schemas.ts
//   <engineDir>/cambium.engine.json   ← sentinel
//
// The runner needs an engine-dir signal so it can:
//   - load `<engineDir>/schemas.ts` instead of the framework's contracts
//   - scan `<engineDir>/*.tool.json` + `<engineDir>/*.action.json`
//   - discover `<engineDir>/*.corrector.ts`
//   - anchor `runs/` under the engine folder
//
// `resolveEngineDir` walks up from the IR's source path (NOT process.cwd —
// the host may be running the engine from any cwd, same way findRetroAgentFile
// uses the primary's source path). Returns null when no sentinel is found
// (the gen is app-mode, not engine-mode).
//
// Path-traversal: the walk only reads `existsSync` on a fixed-name file
// (`cambium.engine.json`) — no user-controlled segments interpolated into paths.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ENGINE_SENTINEL = 'cambium.engine.json';

/**
 * Walk up from `sourcePath` looking for the engine sentinel. Returns the
 * directory containing the sentinel, or `null` if none is found up to
 * the filesystem root.
 *
 * @param sourcePath Absolute or relative path to a file inside a
 *                   potential engine folder (typically `ir.entry.source`).
 */
export function resolveEngineDir(sourcePath: string | undefined | null): string | null {
  if (!sourcePath) return null;
  let dir = dirname(resolve(sourcePath));
  while (true) {
    if (existsSync(join(dir, ENGINE_SENTINEL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}
