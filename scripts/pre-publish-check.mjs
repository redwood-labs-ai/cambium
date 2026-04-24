#!/usr/bin/env node
/**
 * pre-publish-check — automated gate that MUST pass before `npm publish`.
 *
 * Exists because the pre-0.1.1 verification process failed twice:
 *
 *   1. v0.1.0 shipped with `workspaces: ["packages/*"]` in the published
 *      manifest. Caused npm to create a hollow nested shell under
 *      `node_modules/@redwood-labs/cambium/node_modules/@redwood-labs/cambium-runner/`
 *      for consumers. Missed because verification used an empty tmpdir
 *      install, which happens to flatten cleanly.
 *
 *   2. v0.1.1 shipped with `npm-shrinkwrap.json` in the published tarball.
 *      The shrinkwrap captured workspace-relative references from the
 *      monorepo dev environment and LOCKED consumers into the broken
 *      nested layout — overriding the workspaces-strip fix in 0.1.1.
 *      Missed because the published tarball's contents were not inspected
 *      in a realistic consumer install.
 *
 * This script exists so the next publish can't repeat either failure mode.
 * It packs real tarballs (triggering prepack/postpack), installs them into
 * a tmpdir consumer project that has an unrelated runtime dep, and
 * asserts the installed structure is correct. Any assertion failure
 * exits non-zero.
 *
 * Run manually before publish:
 *
 *     npm run pre-publish-check
 *
 * Exit codes:
 *   0  — safe to publish
 *   1+ — do NOT publish; fix the failure first
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  }
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });
}

const packDir = mkdtempSync(join(tmpdir(), 'cambium-prepublish-pack-'));
const consumerDir = mkdtempSync(join(tmpdir(), 'cambium-prepublish-consumer-'));

try {
  // ── Pack both packages — real pack, so prepack/postpack fire ─────────
  console.log('\n[1/6] Packing both tarballs (real pack — prepack/postpack fire)');
  sh(`npm pack --pack-destination "${packDir}"`, { cwd: ROOT });
  sh(`npm pack --workspace @redwood-labs/cambium-runner --pack-destination "${packDir}"`, { cwd: ROOT });

  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  const cliTarball = tarballs.find((f) => f.startsWith('redwood-labs-cambium-') && !f.includes('runner'));
  const runnerTarball = tarballs.find((f) => f.includes('cambium-runner'));
  assert(!!cliTarball, `CLI tarball produced: ${cliTarball ?? '(missing)'}`);
  assert(!!runnerTarball, `Runner tarball produced: ${runnerTarball ?? '(missing)'}`);
  if (!cliTarball || !runnerTarball) throw new Error('Missing tarball — cannot continue');

  // ── Inspect CLI tarball contents — catch shrinkwrap, workspace-source leaks ──
  console.log('\n[2/6] Inspecting CLI tarball contents');
  const cliTarballPath = join(packDir, cliTarball);
  const cliContents = sh(`tar -tzf "${cliTarballPath}"`);
  const cliFiles = cliContents.trim().split('\n');
  const cliPkgJson = sh(`tar -xzOf "${cliTarballPath}" package/package.json`);
  const cliManifest = JSON.parse(cliPkgJson);

  assert(!cliFiles.some((f) => f === 'package/npm-shrinkwrap.json'),
    'CLI tarball does NOT include npm-shrinkwrap.json');
  assert(!cliFiles.some((f) => f.startsWith('package/packages/')),
    'CLI tarball does NOT include raw workspace sources under packages/');
  assert(!('workspaces' in cliManifest),
    'CLI published manifest has NO workspaces field');
  assert(!('devDependencies' in cliManifest),
    'CLI published manifest has NO devDependencies field');
  assert(cliFiles.some((f) => f === 'package/cli/cambium.mjs'),
    'CLI tarball includes cli/cambium.mjs (bin entry)');
  assert(cliFiles.some((f) => f === 'package/ruby/cambium/compile.rb'),
    'CLI tarball includes ruby/cambium/compile.rb');
  assert(cliFiles.some((f) => f === 'package/SECURITY.md'),
    'CLI tarball includes SECURITY.md');

  // ── Install into a realistic consumer project ─────────────────────────
  console.log('\n[3/6] Installing tarballs into a consumer project with other deps');
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({
      name: 'cambium-prepublish-consumer',
      version: '1.0.0',
      type: 'module',
      private: true,
      dependencies: {
        '@redwood-labs/cambium': `file:${join(packDir, cliTarball)}`,
        '@redwood-labs/cambium-runner': `file:${join(packDir, runnerTarball)}`,
        // Unrelated real dep to force a non-trivial dep graph. Dotenv
        // mirrors what the CLI itself already declares, but that's fine —
        // the point is having >1 non-scoped dep in the tree.
        'dotenv': '^17.4.1',
      },
    }, null, 2),
  );
  sh('npm install --no-audit --no-fund', { cwd: consumerDir });

  // ── Structural assertions — the load-bearing checks ──────────────────
  console.log('\n[4/6] Asserting installed structure');
  const scopedDir = join(consumerDir, 'node_modules', '@redwood-labs');
  const cliInstall = join(scopedDir, 'cambium');
  const runnerInstall = join(scopedDir, 'cambium-runner');
  const cliNestedNm = join(cliInstall, 'node_modules');
  const cliPackagesLeak = join(cliInstall, 'packages');

  assert(existsSync(cliInstall), 'node_modules/@redwood-labs/cambium/ exists');
  assert(existsSync(runnerInstall), 'node_modules/@redwood-labs/cambium-runner/ exists (as peer)');
  assert(!existsSync(cliNestedNm),
    'node_modules/@redwood-labs/cambium/node_modules/ does NOT exist (no nested shell)');
  assert(!existsSync(cliPackagesLeak),
    'node_modules/@redwood-labs/cambium/packages/ does NOT exist (no workspace source leak)');
  assert(!existsSync(join(cliInstall, 'npm-shrinkwrap.json')),
    'installed CLI does NOT contain an npm-shrinkwrap.json');
  assert(existsSync(join(cliInstall, 'cli', 'cambium.mjs')),
    'installed CLI has cli/cambium.mjs');
  assert(existsSync(join(cliInstall, 'ruby', 'cambium', 'compile.rb')),
    'installed CLI has ruby/cambium/compile.rb');
  assert(existsSync(join(runnerInstall, 'dist', 'index.js')),
    'installed runner has dist/index.js');

  // ── Functional checks — bin runs, library imports ────────────────────
  console.log('\n[5/6] Running functional smoke checks');
  const binPath = join(consumerDir, 'node_modules', '.bin', 'cambium');
  assert(existsSync(binPath), 'node_modules/.bin/cambium exists');

  // CLI prints usage without crashing (exit code 2 is expected for no args)
  let cliOk = false;
  try {
    execSync(`node "${binPath}"`, { cwd: consumerDir, encoding: 'utf8', stdio: 'pipe' });
    cliOk = true;
  } catch (err) {
    // usage-print exits 2 by design — stderr contains "Cambium" banner
    const combined = String(err.stderr ?? '') + String(err.stdout ?? '');
    cliOk = /Cambium — Rails for generation engineering/.test(combined);
  }
  assert(cliOk, 'CLI bin runs and prints usage banner');

  // Library import works — runGen + runGenFromIr present
  const libCheck = execSync(
    `node -e "import('@redwood-labs/cambium-runner').then(m => { const k = Object.keys(m); if (!k.includes('runGen') || !k.includes('runGenFromIr')) process.exit(1); console.log(k.join(',')); })"`,
    { cwd: consumerDir, encoding: 'utf8' },
  ).trim();
  assert(libCheck.includes('runGen') && libCheck.includes('runGenFromIr'),
    `Library import exposes runGen + runGenFromIr (got: ${libCheck})`);

  // ── Working copy integrity — prepack/postpack restored package.json ──
  console.log('\n[6/6] Verifying working-copy package.json was restored post-pack');
  const postPackManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert('workspaces' in postPackManifest,
    'working-copy package.json has workspaces restored (postpack ran)');
  assert('devDependencies' in postPackManifest,
    'working-copy package.json has devDependencies restored');
  assert(!existsSync(join(ROOT, 'package.json.bak')),
    'no leftover package.json.bak (postpack cleaned up)');
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(consumerDir, { recursive: true, force: true });
}

console.log();
if (failures.length === 0) {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ✓ pre-publish-check PASSED — safe to publish');
  console.log('═══════════════════════════════════════════════════');
  process.exit(0);
} else {
  console.log('═══════════════════════════════════════════════════');
  console.log(`  ✗ pre-publish-check FAILED — ${failures.length} assertion(s) failed`);
  console.log('═══════════════════════════════════════════════════');
  for (const f of failures) console.log(`    - ${f}`);
  console.log('\nDO NOT PUBLISH until these are resolved.');
  process.exit(1);
}
