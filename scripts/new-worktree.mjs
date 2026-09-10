#!/usr/bin/env node
/**
 * new-worktree — create a `git worktree` with a REAL `npm ci`, and prove
 * it isn't silently testing the main checkout. (#243)
 *
 * The obvious way to parallelize work is `git worktree add` + symlink
 * `node_modules` in from the main checkout, to skip the install. That
 * shortcut is unsafe here: npm workspaces self-link each package into the
 * root `node_modules` as a RELATIVE symlink —
 *
 *   node_modules/@redwood-labs/cambium-runner -> ../../packages/cambium-runner
 *
 * Resolved from a symlinked `node_modules`, that relative path lands back
 * in the ORIGINAL checkout, not the worktree. An agent editing
 * `packages/cambium-runner/src/*` in such a worktree can run `npm test`,
 * see green, and have tested unmodified code from `main`. This has
 * silently bitten two independent agents already.
 *
 * This script always runs a real `npm ci` in the new worktree (no
 * shortcut), then asserts the workspace symlink actually resolves inside
 * the worktree before declaring success — the exact invariant the naive
 * approach violates.
 *
 * Usage:
 *   node scripts/new-worktree.mjs <branch-name> [path]
 *
 * `path` defaults to a sibling directory: ../<repo-name>-wt-<branch-slug>
 *
 * Exit codes:
 *   0  — worktree created, `npm ci` succeeded, isolation verified
 *   1  — git/npm command failed, or the isolation check itself failed
 *   2  — bad usage
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function usage() {
  console.error(
    'Usage: node scripts/new-worktree.mjs <branch-name> [path]\n\n' +
    'Creates a git worktree off main at [path] (default: a sibling\n' +
    'directory next to this checkout), runs a real `npm ci` inside it,\n' +
    'and verifies the workspace symlinks resolve INSIDE the worktree\n' +
    'rather than back into this checkout.',
  );
}

function slugify(branch) {
  return branch.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

/**
 * The invariant this whole script exists to prove: the `cambium-runner`
 * workspace package, resolved from INSIDE the worktree's own
 * node_modules, must land on the worktree's OWN packages/cambium-runner
 * — never on some other checkout's.
 *
 * Exported so a caller (including this script's own self-test) can drive
 * both the failing and passing case against arbitrary directories rather
 * than only ever observing whichever case a full `npm ci` happens to
 * produce.
 */
export function checkWorktreeIsolation(worktreePath) {
  const linkPath = join(worktreePath, 'node_modules', '@redwood-labs', 'cambium-runner');
  const ownPackagePath = join(worktreePath, 'packages', 'cambium-runner');

  if (!existsSync(linkPath)) {
    return {
      ok: false,
      message: `${linkPath} does not exist — was 'npm ci' run in this worktree?`,
    };
  }
  if (!existsSync(ownPackagePath)) {
    return {
      ok: false,
      message: `${ownPackagePath} does not exist — is this a cambium worktree?`,
    };
  }

  const resolved = realpathSync(linkPath);
  const expected = realpathSync(ownPackagePath);

  if (resolved !== expected) {
    return {
      ok: false,
      message:
        `node_modules/@redwood-labs/cambium-runner resolves to:\n` +
        `  ${resolved}\n` +
        `but this worktree's own packages/cambium-runner is:\n` +
        `  ${expected}\n\n` +
        `node_modules was almost certainly symlinked in from another checkout ` +
        `rather than produced by a real 'npm ci' in this worktree — npm ` +
        `workspaces self-link with a RELATIVE symlink, so resolving it from a ` +
        `borrowed node_modules lands back in the checkout it was borrowed ` +
        `from. Any edit to packages/cambium-runner/src here would be invisible ` +
        `to 'npm test'. Re-run 'npm ci' inside the worktree itself.`,
    };
  }

  return { ok: true, message: `${linkPath} -> ${resolved} (inside this worktree, as expected)` };
}

async function main() {
  const [branch, explicitPath] = process.argv.slice(2);

  if (!branch || branch.startsWith('-')) {
    usage();
    process.exit(2);
  }

  const worktreePath = explicitPath
    ? resolve(explicitPath)
    : resolve(REPO_ROOT, '..', `${basename(REPO_ROOT)}-wt-${slugify(branch)}`);

  if (existsSync(worktreePath)) {
    console.error(`new-worktree: ${worktreePath} already exists. Choose a different path.`);
    process.exit(1);
  }

  console.log(`[new-worktree] creating worktree at ${worktreePath} (branch '${branch}', off main)…`);
  const add = spawnSync(
    'git',
    ['worktree', 'add', '-b', branch, worktreePath, 'main'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (add.status !== 0) {
    console.error('new-worktree: git worktree add failed.');
    process.exit(1);
  }

  console.log(`[new-worktree] running 'npm ci' in ${worktreePath} (this installs for real — no shortcuts)…`);
  const ci = spawnSync('npm', ['ci'], { cwd: worktreePath, stdio: 'inherit' });
  if (ci.status !== 0) {
    console.error('new-worktree: npm ci failed in the new worktree.');
    process.exit(1);
  }

  console.log('[new-worktree] verifying node_modules resolves inside the worktree, not the main checkout…');
  const result = checkWorktreeIsolation(worktreePath);
  if (!result.ok) {
    console.error(`new-worktree: isolation check FAILED.\n\n${result.message}`);
    process.exit(1);
  }
  console.log(`[new-worktree] isolation check passed: ${result.message}`);

  console.log(`\nWorktree ready: ${worktreePath}`);
  console.log(`Teardown when done: git worktree remove ${worktreePath}`);
}

// Only run main() when invoked as a script — checkWorktreeIsolation is
// also imported directly by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
