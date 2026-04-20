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
// Path-traversal: this helper reads Genfile.toml by name at the walked
// directory. No user-picked segments are interpolated into paths.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
          appPkgRoot: join(dir, 'packages', 'cambium'),
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
