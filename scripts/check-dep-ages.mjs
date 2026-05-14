#!/usr/bin/env node
/**
 * check-dep-ages — supply-chain defense for npm dependencies.
 *
 * Reads `package-lock.json`, queries the npm registry for the publish time
 * of every resolved package version, and fails if any version was published
 * less than MIN_AGE_DAYS ago (default 7).
 *
 * The 7-day window is the project's policy (SECURITY.md, CLAUDE.md):
 * compromised publishes are typically caught within 24-72h, but a longer
 * window is needed for slower-moving worms (Shai-Hulud-style). 7 days
 * balances detection-window with patch-flow latency.
 *
 * Works on any npm version — does NOT rely on npm 11.5's native
 * `minimum-release-age` (which is the install-time enforcement set in
 * `.npmrc`). This script is the version-independent gate: it runs in
 * `npm run audit:ages` and via the pre-publish check.
 *
 * Exit codes:
 *   0  — every resolved version is at least MIN_AGE_DAYS old
 *   1  — at least one version is too new (or a registry lookup failed)
 *
 * Environment overrides:
 *   CAMBIUM_DEP_MIN_AGE_DAYS  — minimum age in days (default 7)
 *   CAMBIUM_DEP_AGE_ALLOWLIST — comma-separated `<name>@<version>` entries
 *                               to skip (use ONLY for emergency security
 *                               patches that must ship before the window;
 *                               leave a note in the commit explaining why)
 *   CAMBIUM_DEP_AGE_LOCKFILE  — path to lockfile (default ./package-lock.json)
 *
 * Adding a new dependency is a deliberate, user-authorized action — see
 * CLAUDE.md "Dependency policy" cluster. This script enforces the age side
 * of that policy; the user-approval side is conventional.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIN_AGE_DAYS = Number(process.env.CAMBIUM_DEP_MIN_AGE_DAYS ?? 7);
const ALLOWLIST = new Set(
  (process.env.CAMBIUM_DEP_AGE_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const LOCKFILE_PATH = resolve(
  process.env.CAMBIUM_DEP_AGE_LOCKFILE ?? 'package-lock.json',
);
const REGISTRY = process.env.CAMBIUM_NPM_REGISTRY ?? 'https://registry.npmjs.org';

// Floor at 1 day. Allowing 0 (or negative) is a silent bypass — `ageMs < 0`
// is never true for a real package — so refuse those values outright. The
// documented escape hatch for emergency patches is `CAMBIUM_DEP_AGE_ALLOWLIST`,
// not lowering the floor.
if (!Number.isFinite(MIN_AGE_DAYS) || MIN_AGE_DAYS < 1) {
  console.error(
    `Invalid CAMBIUM_DEP_MIN_AGE_DAYS=${process.env.CAMBIUM_DEP_MIN_AGE_DAYS} ` +
    `(must be a number >= 1; the project policy is 7). Use CAMBIUM_DEP_AGE_ALLOWLIST ` +
    `for documented per-package exceptions instead of lowering the floor.`,
  );
  process.exit(2);
}

const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const NOW = Date.now();

let lockfile;
try {
  lockfile = JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8'));
} catch (err) {
  console.error(`Could not read lockfile at ${LOCKFILE_PATH}: ${err.message}`);
  process.exit(2);
}

if (lockfile.lockfileVersion !== 3 && lockfile.lockfileVersion !== 2) {
  console.error(
    `Unsupported lockfileVersion=${lockfile.lockfileVersion}. ` +
    `This script expects npm lockfile v2 or v3.`,
  );
  process.exit(2);
}

// Collect (name, version) pairs from every entry under `packages`. The root
// entry (key === '') is the workspace itself — skip it. Workspace-internal
// packages (e.g., `packages/cambium-runner`) have a `link: true` entry —
// skip those too (they're file-linked, not registry-sourced). Any package
// with `resolved` pointing at the npm registry needs an age check.
const entries = [];
for (const [path, meta] of Object.entries(lockfile.packages ?? {})) {
  if (path === '') continue; // root workspace
  if (meta?.link === true) continue; // local workspace link
  if (!meta?.version) continue; // shouldn't happen for non-link entries
  // Skip file: / git: / http: resolvers — only registry entries are age-able.
  const resolved = meta.resolved ?? '';
  if (
    resolved.startsWith('file:') ||
    resolved.startsWith('git+') ||
    (resolved && !resolved.startsWith(REGISTRY) && !resolved.startsWith('https://registry.'))
  ) {
    continue;
  }
  // Derive the canonical package name from the lockfile path. The last
  // `node_modules/<name>` segment is authoritative — `meta.name` is not
  // reliably present.
  const lastNm = path.lastIndexOf('node_modules/');
  if (lastNm === -1) continue;
  const name = path.slice(lastNm + 'node_modules/'.length);
  entries.push({ name, version: meta.version, path });
}

// De-dupe identical (name, version) — same package can be installed under
// multiple paths via hoisting; only need one registry lookup per pair.
const seen = new Map();
for (const e of entries) {
  const key = `${e.name}@${e.version}`;
  if (!seen.has(key)) seen.set(key, e);
}
const unique = Array.from(seen.values());

console.log(
  `Checking ${unique.length} unique (name, version) pairs against ` +
  `${MIN_AGE_DAYS}-day minimum-age policy (registry: ${REGISTRY})`,
);

async function fetchPublishTime(name, version) {
  // The full packument is the canonical source for publish times; the field
  // `time[<version>]` is an ISO timestamp set when the version was first
  // published. Must request the full doc — the abbreviated
  // `application/vnd.npm.install-v1+json` format omits the time map.
  // The per-version endpoint (`/<name>/<version>`) also omits it.
  //
  // URL encoding: the canonical npm CLI form is the literal path
  // `/@scope/pkg` — only the `@` sigil is percent-encoded. Private
  // registries (Verdaccio, Nexus, Artifactory) treat `%2F` as a literal
  // path segment and return 404, so we MUST NOT encode the `/` separator
  // in scoped names.
  const encName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  const url = `${REGISTRY}/${encName}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${name}`);
  }
  const body = await res.json();
  const t = body?.time?.[version];
  if (!t) {
    throw new Error(`No publish time recorded for ${name}@${version}`);
  }
  return Date.parse(t);
}

const CONCURRENCY = 8;
const tooNew = [];
const errors = [];
let processed = 0;

async function worker(queue) {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) return;
    const key = `${item.name}@${item.version}`;
    processed += 1;
    if (ALLOWLIST.has(key)) continue;
    try {
      const publishedAt = await fetchPublishTime(item.name, item.version);
      const ageMs = NOW - publishedAt;
      if (ageMs < MIN_AGE_MS) {
        const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
        tooNew.push({ ...item, publishedAt, ageDays });
      }
    } catch (err) {
      errors.push({ ...item, error: err.message });
    }
  }
}

const queue = unique.slice();
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue));
await Promise.all(workers);

console.log(`Processed ${processed} packages.`);

if (errors.length > 0) {
  console.error(`\n✗ ${errors.length} registry lookup error(s):`);
  for (const e of errors) {
    console.error(`  - ${e.name}@${e.version}: ${e.error}`);
  }
}

if (tooNew.length > 0) {
  console.error(`\n✗ ${tooNew.length} package(s) younger than ${MIN_AGE_DAYS} days:`);
  for (const e of tooNew) {
    const iso = new Date(e.publishedAt).toISOString();
    console.error(`  - ${e.name}@${e.version} (published ${iso}, ${e.ageDays}d ago)`);
  }
  console.error(
    `\nThis is the project's supply-chain defense (SECURITY.md). New publishes ` +
    `must age ${MIN_AGE_DAYS} days before they can be installed. Options:`,
  );
  console.error(`  1. Wait for the version to age into the window (preferred).`);
  console.error(`  2. Downgrade to an older version that already meets the policy.`);
  console.error(
    `  3. EMERGENCY ONLY — set CAMBIUM_DEP_AGE_ALLOWLIST=<name>@<version>,... ` +
    `and document why in the commit message.`,
  );
}

if (tooNew.length > 0 || errors.length > 0) {
  process.exit(1);
}

console.log(`\n✓ All ${unique.length} packages meet the ${MIN_AGE_DAYS}-day minimum age policy.`);
