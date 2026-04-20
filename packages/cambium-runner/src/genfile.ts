// ── Genfile.toml resolver (RED-274) ────────────────────────────────────
//
// App-mode contracts resolution: when a directory has a `Genfile.toml`
// with `[types].contracts = [...]`, the runner loads those files as the
// schemas registry instead of the framework's own
// `packages/cambium/src/contracts.ts`.
//
// Scope is deliberately narrow: we only resolve `[types].contracts`. The
// same hardcoded-relative-to-cwd pattern exists for `app/tools/`,
// `app/actions/`, `app/policies/`, and `app/memory_pools/` — those are
// separate tickets.
//
// Path-traversal stance matches RED-214: paths must be relative AND must
// resolve inside the Genfile directory. Absolute paths, `..` escapes, and
// non-string entries are rejected with a clear error naming the Genfile.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from 'smol-toml';

export interface GenfileResolution {
  /** Absolute path to the directory containing the Genfile.toml. */
  genfileDir: string;
  /** Absolute paths to each declared contracts file, in declaration order. */
  contractsPaths: string[];
  /** Absolute path to the Genfile.toml itself (for error messages). */
  genfilePath: string;
}

/**
 * Look for `Genfile.toml` in `cwd` and resolve its `[types].contracts`
 * list to absolute paths.
 *
 * Returns `null` when:
 *   - no `Genfile.toml` exists in `cwd`
 *   - the Genfile is a workspace (`[workspace]`) or otherwise lacks a
 *     `[types].contracts` list
 *
 * Throws when:
 *   - the Genfile is malformed TOML
 *   - an entry is not a string
 *   - an entry is an absolute path
 *   - an entry resolves outside `cwd` (traversal guard)
 *   - a declared contracts file does not exist on disk
 */
export function resolveGenfileContracts(cwd: string): GenfileResolution | null {
  const genfilePath = join(cwd, 'Genfile.toml');
  if (!existsSync(genfilePath)) return null;

  const text = readFileSync(genfilePath, 'utf8');
  let parsed: any;
  try {
    parsed = parseToml(text);
  } catch (e: any) {
    throw new Error(`Genfile parse error (${genfilePath}): ${e?.message ?? String(e)}`);
  }

  const contracts = parsed?.types?.contracts;
  if (contracts === undefined) return null;
  if (!Array.isArray(contracts)) {
    throw new Error(
      `Genfile error (${genfilePath}): [types].contracts must be an array of strings, got ${typeof contracts}`,
    );
  }
  if (contracts.length === 0) return null;

  const genfileDir = resolve(cwd);
  const resolved: string[] = [];
  for (const entry of contracts) {
    if (typeof entry !== 'string') {
      throw new Error(
        `Genfile error (${genfilePath}): [types].contracts entries must be strings, got ${typeof entry}`,
      );
    }
    // Null bytes silently truncate the path on POSIX at `existsSync` /
    // `import()` time, which would let a TOML entry like
    // `"src/contracts\x00anything"` resolve to `src/contracts` while
    // evading the `..` check below. Explicit reject.
    if (entry.includes('\x00')) {
      throw new Error(
        `Genfile error (${genfilePath}): [types].contracts entry contains a null byte`,
      );
    }
    if (isAbsolute(entry)) {
      throw new Error(
        `Genfile error (${genfilePath}): [types].contracts entry "${entry}" must be relative to the Genfile directory`,
      );
    }
    const abs = resolve(genfileDir, entry);
    const rel = relative(genfileDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `Genfile error (${genfilePath}): [types].contracts entry "${entry}" resolves outside the Genfile directory`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(
        `Genfile error (${genfilePath}): [types].contracts file does not exist: ${entry}`,
      );
    }
    resolved.push(abs);
  }

  return { genfileDir, contractsPaths: resolved, genfilePath };
}

/**
 * Import each contracts file and merge their named exports into a single
 * `{ [$id]: schema }` map suitable for `runGen({ schemas })`.
 *
 * Uses `pathToFileURL` because ESM `import()` of a bare absolute path is
 * non-portable (Windows treats it as a module specifier).
 *
 * Name collisions: later-declared files win (last-write semantics). Two
 * contracts files that both export a schema named `Foo` is almost
 * certainly a bug — we don't throw today because multi-file app-mode
 * contracts are new and a hard failure here would bite before the
 * collision surface is well understood. Revisit if this causes confusion.
 */
export async function loadContractsFromGenfile(
  res: GenfileResolution,
): Promise<Record<string, any>> {
  const merged: Record<string, any> = {};
  for (const absPath of res.contractsPaths) {
    // Sanity rail: every path in a GenfileResolution should have been
    // validated as absolute + inside-Genfile-dir by resolveGenfileContracts.
    // Guard here so a future caller passing a raw, unvalidated path to
    // the loader can't execute an arbitrary file via a bare relative-path
    // specifier. The resolver is the source of truth; this is a
    // machine-checkable contract check.
    if (!isAbsolute(absPath)) {
      throw new Error(
        `loadContractsFromGenfile: path is not absolute — go through resolveGenfileContracts first: ${absPath}`,
      );
    }
    const mod: any = await import(pathToFileURL(absPath).href);
    for (const [k, v] of Object.entries(mod)) {
      if (k === 'default') continue;
      merged[k] = v;
    }
  }
  return merged;
}
