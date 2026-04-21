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
import { dirname, join, relative } from 'node:path';
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

let copied = 0;
walk(SRC, (path) => {
  if (!path.endsWith('.json')) return;
  if (path.endsWith('tsconfig.json')) return;
  if (path.endsWith('package.json')) return;
  const rel = relative(SRC, path);
  const out = join(DEST, rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(path, out);
  copied += 1;
});

console.error(`copy-assets: copied ${copied} JSON file(s) from src/ to dist/`);
