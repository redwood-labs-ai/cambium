// ── Runtime app-package-root resolver (RED-286) ────────────────────────
//
// The runner loads app-supplied tools and actions by scanning a
// directory at startup. Which directory depends on the project layout:
//
//   [workspace] monorepo  → <root>/packages/cambium/app/{tools,actions}
//   [package]   flat      → <root>/app/{tools,actions}
//
// `resolveAppRoot` walks up from cwd looking for a Genfile.toml (or
// legacy packages/cambium/ fallback) and returns the absolute
// app-package root. Mirrors cli/workspace-shape.mjs; kept separate
// because runner runs from `process.cwd()` rather than a CLI entry
// point and the .ts ESM module can't import the .mjs helper directly.
//
// If no anchor is found, returns the legacy behavior:
// `<cwd>/packages/cambium`. This preserves the pre-RED-286 runner
// assumption for any call site that ran without a Genfile in the
// path (e.g. ad-hoc test spawns that happen to pass an IR but don't
// have their own project).
//
// Parse strategy: regex on section headers. A full TOML parser
// (smol-toml) is already a workspace dep via @cambium/runner's
// Genfile resolver, but using it here would pull a heavier surface
// into a hot-path lookup; the classifier only needs to see
// `[workspace]` vs `[package]`. Consistent with the LSP's approach.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface AppRootResolution {
  appPkgRoot: string;
  /** 'workspace' when the Genfile was [workspace] (monorepo) or via
   *  the legacy packages/cambium/ subdir fallback. 'package' when the
   *  Genfile was [package] (flat external app). 'none' when no anchor
   *  was detected — the returned appPkgRoot is a best-effort legacy
   *  path. */
  shape: 'workspace' | 'package' | 'none';
}

export function resolveAppRoot(cwd: string): AppRootResolution {
  let dir = resolve(cwd);
  while (true) {
    const genfile = join(dir, 'Genfile.toml');
    if (existsSync(genfile)) {
      const shape = classifyGenfile(genfile);
      if (shape === 'workspace') {
        return { appPkgRoot: join(dir, 'packages', 'cambium'), shape: 'workspace' };
      }
      if (shape === 'package') {
        return { appPkgRoot: dir, shape: 'package' };
      }
      // Malformed Genfile — break out of the walk and fall through to
      // the legacy default rather than throwing. Runtime dispatch is a
      // hot path; the CLI already validates Genfiles at compile time.
      break;
    }
    if (existsSync(join(dir, 'packages', 'cambium'))) {
      return { appPkgRoot: join(dir, 'packages', 'cambium'), shape: 'workspace' };
    }
    const parent = dirname(dir);
    if (parent === dir) break; // fs root
    dir = parent;
  }
  // Legacy default: assume the cambium monorepo layout so in-tree
  // spawns without any Genfile (e.g. test harnesses) keep working.
  return { appPkgRoot: join(cwd, 'packages', 'cambium'), shape: 'none' };
}

function classifyGenfile(genfilePath: string): 'workspace' | 'package' | null {
  let content: string;
  try {
    content = readFileSync(genfilePath, 'utf8');
  } catch {
    return null;
  }
  if (/^\s*\[workspace\]/m.test(content)) return 'workspace';
  if (/^\s*\[package\]/m.test(content)) return 'package';
  return null;
}
