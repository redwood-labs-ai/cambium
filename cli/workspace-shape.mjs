// ── Genfile shape detection (RED-286) ─────────────────────────────────
//
// Cambium supports two project layouts:
//
//   [workspace] — monorepo root with `members = ["packages/*"]`; the
//                 actual app package (gens, tools, etc.) lives at
//                 `<root>/packages/cambium/`. This is the cambium repo's
//                 own layout.
//
//   [package]   — flat project with `[package]` at top level; app
//                 surfaces live at `<root>/app/...`. This is the shape
//                 an external app (e.g. the curator dogfood) sees.
//
// The CLI scaffolders, lint dispatch, and LSP workspace scan all need
// to resolve the same anchor: the directory that holds `app/gens/`,
// `app/tools/`, etc. We call that `appPkgRoot`. The helper below walks
// up from `startDir` until it finds a Genfile (or a legacy fallback
// `packages/cambium/` subdir with no Genfile), parses the shape, and
// returns the two anchors the callers need.
//
// Legacy fallback: if the walk encounters a `packages/cambium/` subdir
// at a directory that has no Genfile, treat it as a `[workspace]`
// shape. This keeps the pre-Genfile behavior working in case a user
// deletes their root Genfile.
//
// Path-traversal: the walk itself reads Genfile.toml by name at each
// directory, interpolating nothing. `members` (RED-159) IS user-supplied
// and IS joined onto a path, so `expandMembers` guards it the same way
// `genfile.ts#resolveGenfileContracts` guards `[types].contracts`: no
// absolute patterns, no `..` segments, and a `relative()` escape check
// after resolve.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * Walk up from `startDir` to find the nearest Cambium workspace anchor
 * and classify its layout.
 *
 * @param {string} startDir Absolute starting directory.
 * @returns {{
 *   workspaceRoot: string,
 *   shape: 'workspace' | 'package',
 *   appPkgRoot: string,
 * } | null} `null` when no Genfile and no legacy `packages/cambium/`
 *            subdir are found anywhere up to the filesystem root.
 */
export function detectWorkspaceShape(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const genfile = join(dir, 'Genfile.toml');
    if (existsSync(genfile)) {
      const shape = classifyGenfile(genfile);
      if (shape === 'workspace') {
        return {
          workspaceRoot: dir,
          shape: 'workspace',
          appPkgRoot: resolveAppPkgRoot(dir, genfile, resolve(startDir)),
        };
      }
      if (shape === 'package') {
        return {
          workspaceRoot: dir,
          shape: 'package',
          appPkgRoot: dir,
        };
      }
      // Shape === null: malformed or empty Genfile. Don't silently
      // continue walking up — surface the problem. The caller can
      // catch-and-downgrade if it wants a soft landing.
      throw new Error(
        `Genfile at ${genfile} has neither [workspace] nor [package]. ` +
        `Add one of:\n  [workspace]\n  members = ["packages/*"]\nor\n  [package]\n  name = "..."\n  version = "..."`,
      );
    }

    // Legacy fallback: dir has no Genfile but holds a packages/cambium/
    // subdir. Treat as [workspace] shape. Keeps the pre-Genfile cambium
    // repo behavior working.
    if (existsSync(join(dir, 'packages', 'cambium'))) {
      return {
        workspaceRoot: dir,
        shape: 'workspace',
        appPkgRoot: join(dir, 'packages', 'cambium'),
      };
    }

    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Expand a `[workspace] members` list into the member package directories
 * that actually hold a `Genfile.toml`. Mirrors the glob walk `cambium lint`
 * already does, which is why a drifted workspace linted clean while the
 * hardcoded `packages/cambium/` sat unlinted (RED-159).
 *
 * `members` comes from a user-authored file, so each pattern is guarded
 * before it is joined: no absolute paths, no `..` segments, and the
 * resolved directory must still be inside `workspaceRoot`.
 *
 * @param {string} workspaceRoot
 * @param {unknown} members Raw `workspace.members` value.
 * @returns {string[]} Absolute member dirs, sorted, each containing a Genfile.
 */
function expandMembers(workspaceRoot, members) {
  const patterns = Array.isArray(members) ? members : members == null ? [] : [members];
  const found = [];

  const accept = (abs) => {
    const rel = relative(workspaceRoot, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return; // escaped the workspace
    if (existsSync(join(abs, 'Genfile.toml'))) found.push(abs);
  };

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) continue;

    if (pattern.includes('*')) {
      // Only the trailing `packages/*` form is meaningful here; anything
      // deeper is treated as its literal parent directory.
      const parent = join(workspaceRoot, pattern.replace(/\*.*$/, ''));
      if (!existsSync(parent)) continue;
      let entries;
      try {
        entries = readdirSync(parent).sort();
      } catch {
        continue;
      }
      for (const entry of entries) accept(join(parent, entry));
    } else {
      accept(join(workspaceRoot, pattern));
    }
  }
  return found;
}

/** `kinds` from a member package's Genfile, or `[]` if unreadable. */
function genfileKinds(pkgDir) {
  try {
    const parsed = parseToml(readFileSync(join(pkgDir, 'Genfile.toml'), 'utf8'));
    const kinds = parsed?.package?.kinds;
    return Array.isArray(kinds) ? kinds.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve which member package holds `app/gens/` etc. for a `[workspace]`
 * root.
 *
 * Before RED-159 this was hardcoded to `<root>/packages/cambium`, which is
 * only correct for the cambium monorepo itself: `cambium init demoapp`
 * writes `packages/demoapp/`, so `cambium new agent Foo` then scaffolded
 * into a `packages/cambium/` nothing else referenced.
 *
 * Selection order:
 *   1. Members declaring `kinds = ["app", ...]` — the precise signal.
 *   2. Failing that, any member with a Genfile (a workspace whose packages
 *      predate `kinds`).
 *   3. Failing that, the legacy `<root>/packages/cambium` guess, preserving
 *      the pre-Genfile behavior for a root with no usable members.
 *
 * With several candidates, the one containing `startDir` wins — running
 * `cambium new agent` from inside a package means that package. Otherwise
 * the ambiguity is real and gets reported rather than guessed at.
 *
 * The cambium monorepo still resolves to `packages/cambium`: it is the only
 * member with a Genfile, and it declares `kinds = ["app", "tooling"]`.
 *
 * @param {string} workspaceRoot
 * @param {string} genfilePath
 * @param {string} startDir Absolute; the directory detection started from.
 * @returns {string}
 */
function resolveAppPkgRoot(workspaceRoot, genfilePath, startDir) {
  let members;
  try {
    members = parseToml(readFileSync(genfilePath, 'utf8'))?.workspace?.members;
  } catch {
    members = null;
  }

  const all = expandMembers(workspaceRoot, members);
  const apps = all.filter((d) => genfileKinds(d).includes('app'));
  const candidates = apps.length > 0 ? apps : all;

  if (candidates.length === 0) return join(workspaceRoot, 'packages', 'cambium');
  if (candidates.length === 1) return candidates[0];

  const containing = candidates.find((d) => {
    const rel = relative(d, startDir);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (containing) return containing;

  throw new Error(
    `Ambiguous workspace: ${candidates.length} member packages declare an app ` +
    `(${candidates.map((d) => relative(workspaceRoot, d)).join(', ')}).\n` +
    `Run the command from inside the package you mean.`,
  );
}

/**
 * Classify a Genfile.toml by its top-level sections. Returns:
 *   - `'workspace'` when `[workspace]` is present (wins if both exist)
 *   - `'package'`   when `[package]` is present
 *   - `null`        when the file is malformed, empty, or has neither
 *
 * `[workspace]` wins on conflict because a workspace-declared root
 * genuinely is a workspace even if it also ships a package for testing —
 * the members list is what drives lint.
 *
 * @param {string} genfilePath
 * @returns {'workspace' | 'package' | null}
 */
function classifyGenfile(genfilePath) {
  let parsed;
  try {
    parsed = parseToml(readFileSync(genfilePath, 'utf8'));
  } catch (e) {
    throw new Error(`Genfile parse error (${genfilePath}): ${e?.message ?? String(e)}`);
  }
  if (parsed?.workspace) return 'workspace';
  if (parsed?.package) return 'package';
  return null;
}
