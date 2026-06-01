#!/usr/bin/env node
// RED-306: post-build asset copy.
//
// `tsc` only emits JS from TS input — it doesn't copy sibling .json
// files. The runner's registries expect `.tool.json` / `.action.json`
// schema definitions next to their handler files at runtime. Copy
// those from src/ to dist/ after tsc emission.
//
// Keep this script dependency-free (plain node) so `npm run build`
// doesn't need to install anything transitive.

import { readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const DEST = join(HERE, '..', 'dist');

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, visit);
    else visit(full);
  }
}

// Viewer assets (RED-313): the `cambium inspect` server reads its static
// files from `<module>/public/` at runtime, so those must land in dist/.
const VIEWER_ASSET_EXT = new Set(['.html', '.css', '.svg', '.js']);
const PUBLIC_FRAGMENT = `${sep}inspect${sep}public${sep}`;
const FIXTURES_FRAGMENT = `${sep}__fixtures__${sep}`;

let copied = 0;
walk(SRC, (path) => {
  // Never ship test fixtures in the published tarball.
  if (path.includes(FIXTURES_FRAGMENT)) return;

  const isJson =
    path.endsWith('.json') && !path.endsWith('tsconfig.json') && !path.endsWith('package.json');
  // Viewer static assets, but only under inspect/public/ (not stray .js, which
  // tsc emits itself — those aren't ours to copy).
  const isViewerAsset = path.includes(PUBLIC_FRAGMENT) && VIEWER_ASSET_EXT.has(extname(path));

  if (!isJson && !isViewerAsset) return;
  const rel = relative(SRC, path);
  const out = join(DEST, rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(path, out);
  copied += 1;
});

console.error(`copy-assets: copied ${copied} asset file(s) from src/ to dist/`);
