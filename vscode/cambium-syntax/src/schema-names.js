'use strict';

// #255 (follow-up to #210/#212): schema-name discovery for the LSP's
// hover/completion routes through the shared classifier's export
// LISTING (`cli/schema-export.mjs`'s `listExports`) instead of carrying
// a sixth independent `export const` regex under vscode/. This file has
// no `vscode-languageserver` import — it's plain Node so it can be
// required from `packages/cambium/tests/` directly (DEC-004).
//
// DEC-001 (packaging): the extension ships standalone with no build
// step and no bundler, so the module can't be bundled or vendored — it
// is resolved FROM THE WORKSPACE BEING SERVED, at runtime, via two
// links:
//   1. `<workspaceRoot>/cli/schema-export.mjs` — the in-tree cambium
//      monorepo (this repo, or any fork with the same layout).
//   2. `@redwood-labs/cambium/cli/schema-export.mjs`, resolved via
//      `require.resolve` anchored at workspaceRoot — an external
//      `[package]` app's own installed cambium dependency. Root
//      `package.json`'s `files` field ships the whole `cli/` dir in
//      the npm tarball, so this path exists on every install.
// Both links failing (non-cambium folder, an install predating #255) →
// DEC-002's degrade: schema-name enrichment is omitted, one quiet log
// line, never a thrown error and never the deleted regex as a fallback.
//
// The module is ESM; this file is CJS (matching the LSP host) — loaded
// via a lazily-cached dynamic `import()`, one load per workspace root.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

// workspaceRoot -> Promise<Module|null>. A workspace whose resolution
// already failed stays cached as null rather than re-attempting (and
// re-logging) the resolution on every scan.
const moduleCache = new Map();

function resolveModulePath(workspaceRoot) {
  const inTree = path.join(workspaceRoot, 'cli', 'schema-export.mjs');
  if (fs.existsSync(inTree)) return inTree;

  try {
    return createRequire(path.join(workspaceRoot, 'noop.js')).resolve(
      '@redwood-labs/cambium/cli/schema-export.mjs',
    );
  } catch {
    return null;
  }
}

function loadModule(workspaceRoot) {
  if (moduleCache.has(workspaceRoot)) return moduleCache.get(workspaceRoot);

  const modulePath = resolveModulePath(workspaceRoot);
  const promise = modulePath
    ? import(pathToFileURL(modulePath).href).catch(() => null)
    : Promise.resolve(null);

  const cached = promise.then((mod) => {
    if (!mod) {
      // DEC-002: quiet degrade — one log line, no user-facing error, no
      // regex fallback.
      console.error(
        '[cambium-syntax] schema-export module not resolvable for this workspace; ' +
          'schema-name hover/completion is disabled for it.',
      );
    }
    return mod;
  });
  moduleCache.set(workspaceRoot, cached);
  return cached;
}

function escapeForLineSearch(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * listSchemaNames(workspaceRoot, content) -> Promise<Array<{ name, line }>>
 *
 * DEC-003: returns every name the shared module's `listExports` can see
 * — declarations and export-list entries (alias-aware) — and nothing
 * it can't; a file containing `export *` still contributes whatever
 * names ARE visible, silently partial, never a warning and never an
 * invented name. `line` is a best-effort UI position (first line
 * containing the identifier as a whole word) for hover/go-to-definition
 * — it is not part of the export classification itself.
 */
async function listSchemaNames(workspaceRoot, content) {
  const mod = await loadModule(workspaceRoot);
  if (!mod) return [];

  let names;
  try {
    names = mod.listExports(content);
  } catch {
    return [];
  }

  const lines = content.split('\n');
  return names.map((name) => {
    const re = new RegExp(`\\b${escapeForLineSearch(name)}\\b`);
    const line = lines.findIndex((l) => re.test(l));
    return { name, line: line >= 0 ? line : 0 };
  });
}

module.exports = { listSchemaNames, resolveModulePath };
