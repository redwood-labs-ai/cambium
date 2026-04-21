// ── Log plugin loader (RED-282 / RED-302) ────────────────────────────
//
// Scans `<baseDir>/app/logs/*.log.ts` (app mode) or `<engineDir>/*.log.ts`
// (engine mode) and returns a `{ [name]: LogSink }` map. Mirrors the
// RED-275 app-corrector loader almost line-for-line:
//
// - Name regex `/^[a-z][a-z0-9_]*$/` (matches the same cambium-wide
//   convention enforced by Ruby's LogProfile.load).
// - Realpath escape guard against a symlinked plugins dir pointing
//   at an unrelated tree.
// - Module export must match the file basename (`honeycomb.log.ts`
//   must export `honeycomb`).
//
// App plugins override framework built-ins with the same name (same
// precedence hook as tool / corrector plugins — RED-209 / RED-275).
// The runner emits a one-time stderr warning per override per process.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LogSink } from './event.js';

const NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const FILE_SUFFIX = '.log.ts';

export interface AppLogPluginLoadResult {
  sinks: Record<string, LogSink>;
  loadedFiles: string[];
}

/**
 * Scan `<baseDir>/app/logs/*.log.ts` or `<engineDir>/*.log.ts` and
 * return discovered log sinks. Returns empty when the directory is
 * absent. Throws when a file fails name regex, escapes the plugins
 * dir, or doesn't export a binding matching its basename.
 */
export async function loadAppLogSinks(
  baseDir: string,
  opts?: { engineDir?: string },
): Promise<AppLogPluginLoadResult> {
  const result: AppLogPluginLoadResult = { sinks: {}, loadedFiles: [] };
  const engineDir = opts?.engineDir;
  const logsDir = engineDir ? engineDir : join(baseDir, 'app', 'logs');
  if (!isAbsolute(logsDir)) {
    throw new Error(
      `loadAppLogSinks: log plugin dir must be absolute, got ${logsDir}`,
    );
  }
  if (!existsSync(logsDir)) return result;

  const logsDirReal = realpathSync(logsDir);
  const entries = readdirSync(logsDir);

  for (const entry of entries) {
    if (!entry.endsWith(FILE_SUFFIX)) continue;

    const name = entry.slice(0, -FILE_SUFFIX.length);
    if (!NAME_REGEX.test(name)) {
      throw new Error(
        `App log sink name "${name}" (${entry}) must match ${NAME_REGEX}. ` +
        `Rename the file or move it out of app/logs/.`,
      );
    }

    const abs = join(logsDir, entry);
    const absReal = realpathSync(abs);
    const rel = relative(logsDirReal, absReal);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `App log sink "${entry}" resolves outside app/logs/ (via symlink): ${absReal}`,
      );
    }

    const mod: any = await import(pathToFileURL(abs).href);
    const fn = mod[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `App log sink file ${entry} must export a function named "${name}" ` +
        `(matching the file basename). Found exports: [${Object.keys(mod).filter(k => k !== 'default').join(', ')}].`,
      );
    }

    result.sinks[name] = fn as LogSink;
    result.loadedFiles.push(abs);
  }

  return result;
}
