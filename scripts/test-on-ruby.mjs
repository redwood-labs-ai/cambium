#!/usr/bin/env node
/**
 * test-on-ruby — run the full suite under a chosen Ruby 3.x on Alpine, in
 * Docker. (RED-378)
 *
 * RED-377 shipped as an urgent 0.4.1 patch because `Proc.new` (removed in
 * Ruby 3.0) still worked on the EOL Ruby 2.6 the bug slipped past in dev,
 * while `cambium serve` on Alpine (Ruby 3.4) crashed on the first block-form
 * `generate`. `npm test` invokes `ruby ruby/cambium/compile.rb` in dozens of
 * places — if those ran under Ruby 3.x, the bug would have been caught.
 *
 * There's no CI (single contributor); the pre-publish gate is the mandatory
 * automation. This script is the "run it for real" half of the Ruby-3.x
 * defense — RED-379's `check-ruby-compat.mjs` is the cheap audit-time half.
 * Both ship (defense in depth).
 *
 * How it works (no host contamination):
 *   1. Build/cache a `ruby:<v>-alpine` image with Node + the native-build
 *      toolchain (reproduces the Alpine deploy target — the env RED-377 bit).
 *   2. Pipe a clean `git archive HEAD` (tracked files only — no node_modules,
 *      dist, or runs) into a container, extract, `npm ci`, `npm test`.
 *   The host tree + node_modules are never touched.
 *
 * Usage:
 *   node scripts/test-on-ruby.mjs [--ruby-version 3.4]
 *
 * Exit codes:
 *   0  — suite passed under the chosen Ruby
 *   1  — suite (or build) failed
 *   2  — Docker unavailable / bad args
 */

import { execSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let rubyVersion = '3.4';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ruby-version') rubyVersion = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: node scripts/test-on-ruby.mjs [--ruby-version <x.y[.z]>]\n\nRuns npm ci && npm test inside a ruby:<v>-alpine container. Default 3.4.`);
    process.exit(0);
  } else {
    console.error(`test-on-ruby: unknown flag '${a}'`);
    process.exit(2);
  }
}
if (!/^\d+\.\d+(\.\d+)?$/.test(rubyVersion)) {
  console.error(`test-on-ruby: --ruby-version must look like 3.4 or 3.4.1 (got '${rubyVersion}')`);
  process.exit(2);
}

// Docker is required — fail loud (a publish gate you can't run isn't a gate).
try {
  execSync('docker version', { stdio: 'pipe' });
} catch {
  console.error(
    'test-on-ruby: Docker is required but not available/running. Start Docker and retry, ' +
    'or run this gate on a machine with Docker before publishing.',
  );
  process.exit(2);
}

const image = `cambium-ruby-test:${rubyVersion}`;
// Alpine reproduces the deploy target (musl, BusyBox) that RED-377 bit.
// build-base + python3 cover better-sqlite3's native build; gcompat lets any
// glibc-prebuilt optional deps load under musl.
const dockerfile = `FROM ruby:${rubyVersion}-alpine
RUN apk add --no-cache nodejs npm python3 build-base git bash gcompat sqlite-dev
WORKDIR /app
`;

console.log(`[test-on-ruby] building ${image} (ruby ${rubyVersion}-alpine + node + toolchain)…`);
const build = spawnSync('docker', ['build', '-t', image, '-'], {
  input: dockerfile,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (build.status !== 0) {
  console.error('test-on-ruby: docker build failed.');
  process.exit(build.status ?? 1);
}

// Tracked files only — no node_modules (host musl/glibc mismatch), no dist, no runs.
const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
if (archive.status !== 0) {
  console.error('test-on-ruby: `git archive HEAD` failed.');
  process.exit(1);
}

const script = [
  'set -e',
  'mkdir -p /app && cd /app',
  'tar -x', // extracts the piped git archive from stdin
  'echo "[test-on-ruby] ruby: $(ruby --version)"',
  'echo "[test-on-ruby] node: $(node --version)"',
  'npm ci --no-audit --no-fund',
  'npm test',
].join(' && ');

console.log(`[test-on-ruby] running npm ci && npm test under Ruby ${rubyVersion}…`);
const run = spawnSync('docker', ['run', '--rm', '-i', image, 'sh', '-c', script], {
  input: archive.stdout,
  stdio: ['pipe', 'inherit', 'inherit'],
  maxBuffer: 1024 * 1024 * 1024,
});

if (run.status === 0) {
  console.log(`\n[test-on-ruby] ✓ suite passed under Ruby ${rubyVersion}.`);
  process.exit(0);
}
console.error(`\n[test-on-ruby] ✗ suite FAILED under Ruby ${rubyVersion} (exit ${run.status}).`);
process.exit(run.status ?? 1);
