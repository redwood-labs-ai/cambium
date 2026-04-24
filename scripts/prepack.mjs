#!/usr/bin/env node
/**
 * prepack — strip monorepo-development-only fields from the CLI's
 * package.json before `npm pack` / `npm publish` creates the tarball.
 * Paired with postpack.mjs which restores the working copy after.
 *
 * Why this exists
 * ---------------
 * The root package.json doubles as the `@redwood-labs/cambium` CLI
 * package manifest AND the npm workspaces root for development. The
 * `workspaces: ["packages/*"]` field is only meaningful during dev —
 * when npm sees it in an INSTALLED package (because we published it),
 * it tries to treat the installed package as a workspace root and
 * creates a hollow nested shell under
 * `node_modules/@redwood-labs/cambium/node_modules/@redwood-labs/cambium-runner/`
 * that breaks resolution for consumers.
 *
 * The fix is to publish a manifest WITHOUT `workspaces` (and a few
 * other dev-only fields) while keeping the working copy unchanged so
 * `npm install` at the repo root still links the sibling package.
 *
 * Fields stripped for publish
 * ---------------------------
 * - workspaces         — the real bug (per above).
 * - devDependencies    — harmless in a tarball but pollutes the manifest
 *                        consumers inspect; standard to strip.
 * - scripts.test       — dev-only; consumers don't run `npm test` on
 *                        an installed dep.
 * - scripts.build      — dev-only; same reason.
 *
 * Preserved for publish
 * ---------------------
 * Everything else: name, version, description, license, author,
 * homepage, repository, bugs, keywords, type, bin, files, runtime
 * `dependencies`, `scripts.run` (for `npm run run`), `scripts.compile`.
 *
 * Also preserved: the working-copy package.json is restored by postpack
 * so nothing looks different in git after publish.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = resolve(ROOT, 'package.json');
const BAK = resolve(ROOT, 'package.json.bak');

if (existsSync(BAK)) {
  console.error(
    'prepack: package.json.bak already exists. A previous pack/publish ' +
    'likely failed without running postpack. Restore package.json from ' +
    'the backup manually (and delete the backup) before retrying.',
  );
  process.exit(1);
}

const originalText = readFileSync(PKG, 'utf8');
writeFileSync(BAK, originalText);

const pkg = JSON.parse(originalText);
delete pkg.workspaces;
delete pkg.devDependencies;
if (pkg.scripts) {
  delete pkg.scripts.test;
  delete pkg.scripts.build;
}

writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
console.error(
  'prepack: wrote publish-facing package.json (stripped workspaces, ' +
  'devDependencies, scripts.test, scripts.build). postpack will restore.',
);
