// RED-295: .env discovery for external-app invocations.
//
// Old behavior: `import 'dotenv/config'` at the top of cli/cambium.mjs
// read .env from cwd only. Fine inside the cambium monorepo (cwd
// usually had .env), broken for any external app whose cwd had no
// .env — the user hit an opaque HTTP 401 from oMLX because
// CAMBIUM_OMLX_API_KEY never entered the process env.
//
// New behavior: walk up from cwd looking for a .env file; first one
// found wins (same shape as direnv / pipenv / uv). Then ALWAYS layer
// the framework install's own .env underneath as a baseline, so
// external apps inherit framework env (API keys, baseurl overrides)
// without local setup.
//
// Precedence (highest wins):
//   1. shell / pre-set process.env — always
//   2. project .env — first .env found walking up from cwd
//   3. framework .env — next to the CLI's install root
//
// Mechanics: dotenv.config's default `override: false` means every
// load skips keys already in process.env. Applying project first and
// framework second yields the precedence above for free.
//
// The resolved paths are returned so `cambium doctor` can surface
// them — answering "where did this key come from?" is a common
// source of confusion.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ENV = resolve(CLI_DIR, '..', '.env');

// Walk up from `startDir` looking for a .env file. Returns the first
// absolute path found, or null if none found up to fs root.
export function findProjectEnv(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve the framework install's .env path. The file may not exist
// (e.g. a published package install without bundled .env); callers
// must check existsSync before loading.
export function frameworkEnvPath() {
  return FRAMEWORK_ENV;
}

// Inspect what loadEnvFiles would load, without mutating process.env.
// Used by `cambium doctor` to report the resolved layering. Returns
// entries in the order they'd be applied (project first, framework
// second). Excludes the framework entry when it's the same file as
// the project .env (in-tree monorepo case where walk-up lands on the
// same file).
export function discoverEnvFiles(cwd = process.cwd()) {
  const files = [];
  const projectEnv = findProjectEnv(cwd);
  if (projectEnv) files.push({ kind: 'project', path: projectEnv });
  if (existsSync(FRAMEWORK_ENV) && FRAMEWORK_ENV !== projectEnv) {
    files.push({ kind: 'framework', path: FRAMEWORK_ENV });
  }
  return files;
}

// Load project .env (walk-up discovery from cwd) then framework .env
// as a baseline. Both load with dotenv's default override=false so
// pre-set process.env wins and project beats framework.
//
// Returns the list of files actually applied, in order, for
// diagnostic display.
export function loadEnvFiles(cwd = process.cwd()) {
  const files = discoverEnvFiles(cwd);
  for (const entry of files) {
    // quiet: suppress dotenv's per-file "◇ injected env (N) from …"
    // log line. Users don't need that chatter on every CLI invocation;
    // `cambium doctor` is the opinionated place to surface which
    // files were loaded.
    dotenvConfig({ path: entry.path, quiet: true });
  }
  return files;
}
