// ── App-corrector loader (RED-275) ────────────────────────────────────
//
// Scans `<genfileDir>/app/correctors/*.corrector.ts`, validates each
// basename against the RED-214/215 name regex, imports each via
// `pathToFileURL`, and returns a `{ [name]: CorrectorFn }` map ready
// for `registerAppCorrectors`.
//
// Convention: file `<name>.corrector.ts` must export a top-level binding
// named `<name>`. This makes the export a one-to-one mirror of the file
// name (same convention as `*.tool.ts` under RED-209) and makes the
// discovery mechanism trivial to reason about from the filesystem alone.
//
// Path-traversal stance: the name regex `/^[a-z][a-z0-9_]*$/` is the
// single gate on which files we require. We only enumerate inside the
// declared `app/correctors/` directory, and we reject any basename that
// doesn't match the regex — so a symlink named `../evil.corrector.ts`
// would be ignored (basename parses as `..` → fails the regex). We
// additionally `realpath`-check each resolved file and verify it still
// lives under `appCorrectorsDir` after symlink resolution, matching the
// `resolveGenfileContracts` stance in RED-274.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CorrectorFn } from './types.js';

const NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const FILE_SUFFIX = '.corrector.ts';

export interface AppCorrectorLoadResult {
  /** Map of `{ [name]: CorrectorFn }` suitable for `registerAppCorrectors`. */
  correctors: Record<string, CorrectorFn>;
  /** Absolute paths actually imported, in the order they were loaded. */
  loadedFiles: string[];
}

/**
 * Scan `<genfileDir>/app/correctors/*.corrector.ts` (app mode) or
 * `<engineDir>/*.corrector.ts` (engine mode, RED-287) and return the
 * discovered correctors. Returns an empty map when the directory doesn't
 * exist (app simply didn't declare any). Throws when a file's basename
 * fails the name regex, when its resolved path escapes the correctors
 * directory, or when the module doesn't export a binding matching its
 * basename.
 *
 * @param baseDir Absolute path. In app mode pass the Genfile directory;
 *                the loader appends `app/correctors/`. In engine mode
 *                pass `{ engineDir: '<dir>' }` — the loader scans that
 *                dir directly for sibling correctors alongside the gen.
 */
export async function loadAppCorrectors(
  baseDir: string,
  opts?: { engineDir?: string },
): Promise<AppCorrectorLoadResult> {
  const result: AppCorrectorLoadResult = { correctors: {}, loadedFiles: [] };
  const engineDir = opts?.engineDir;
  const correctorsDir = engineDir
    ? engineDir
    : join(baseDir, 'app', 'correctors');
  if (!isAbsolute(correctorsDir)) {
    throw new Error(
      `loadAppCorrectors: corrector dir must be absolute, got ${correctorsDir}`,
    );
  }
  if (!existsSync(correctorsDir)) return result;

  // Resolve the correctors dir through realpath so the
  // inside-directory check below catches a symlinked `app/correctors/`
  // pointing at an unrelated tree.
  const correctorsDirReal = realpathSync(correctorsDir);

  const entries = readdirSync(correctorsDir);
  for (const entry of entries) {
    if (!entry.endsWith(FILE_SUFFIX)) continue;

    const name = entry.slice(0, -FILE_SUFFIX.length);
    if (!NAME_REGEX.test(name)) {
      throw new Error(
        `App corrector name "${name}" (${entry}) must match ${NAME_REGEX}. ` +
        `Rename the file or move it out of app/correctors/.`,
      );
    }

    const abs = join(correctorsDir, entry);
    const absReal = realpathSync(abs);
    const rel = relative(correctorsDirReal, absReal);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `App corrector "${entry}" resolves outside app/correctors/ (via symlink): ${absReal}`,
      );
    }

    const mod: any = await import(pathToFileURL(abs).href);
    const fn = mod[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `App corrector file ${entry} must export a function named "${name}" ` +
        `(matching the file basename). Found exports: [${Object.keys(mod).filter(k => k !== 'default').join(', ')}].`,
      );
    }

    result.correctors[name] = fn as CorrectorFn;
    result.loadedFiles.push(abs);
  }

  return result;
}
