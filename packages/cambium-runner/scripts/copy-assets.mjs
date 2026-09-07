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

import { readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  // .mjs worker files: plain JavaScript workers (e.g. wasm-worker.mjs) that
  // are referenced at runtime via `new URL('./wasm-worker.mjs', import.meta.url)`.
  // tsc doesn't compile them; they must be copied manually (AUD-003).
  const isMjsWorker = path.endsWith('.mjs') && !path.includes(PUBLIC_FRAGMENT);

  if (!isJson && !isViewerAsset && !isMjsWorker) return;
  const rel = relative(SRC, path);
  const out = join(DEST, rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(path, out);
  copied += 1;
});

console.error(`copy-assets: copied ${copied} asset file(s) from src/ to dist/`);

// Build provenance stamp, read by cli/runner-freshness.mjs.
//
// The mtime comparison there detects a stale dist on its own; this file
// exists to EXPLAIN one — "dist/ was built from main@f75d1ac" is the line
// that distinguishes "I forgot to rebuild" from "I'm running another
// branch's code", which is the case that actually wastes an hour.
//
// Every field is best-effort: a tarball build, a git-less container, or a
// detached worktree just yields nulls and the guard omits the line.
function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: HERE, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
// `git status --porcelain` prints nothing on a clean tree, so a successful
// empty result and a failed call both come back '' / null respectively —
// distinguish them once rather than shelling out twice.
const porcelain = head === null ? null : git(['status', '--porcelain']);
writeFileSync(
  join(DEST, 'build-info.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      branch: branch === 'HEAD' ? null : branch, // detached HEAD
      head,
      dirty: porcelain === null ? null : porcelain !== '',
    },
    null,
    2,
  ) + '\n',
);
