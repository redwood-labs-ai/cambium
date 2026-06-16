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
  // ── Supply-chain age gate — every locked dep must meet the policy ────
  console.log('\n[0/6] Auditing dependency ages (supply-chain defense)');
  try {
    sh('node scripts/check-dep-ages.mjs', { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
    assert(true, 'all locked dependencies meet the minimum-age policy');
  } catch (err) {
    assert(false, `dependency age audit FAILED (see output above): ${err.message ?? err}`);
  }

  // ── Ruby surface — must be stdlib-only ───────────────────────────────
  console.log('\n[0.5/6] Auditing Ruby requires (stdlib-only policy)');
  try {
    sh('node scripts/check-ruby-deps.mjs', { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
    assert(true, 'Ruby surface uses only stdlib (no third-party gems)');
  } catch (err) {
    assert(false, `Ruby stdlib-only audit FAILED (see output above): ${err.message ?? err}`);
  }

  // ── Ruby surface — no removed-in-3.x patterns (RED-379) ──────────────
  console.log('\n[0.6/6] Auditing Ruby 3.x compat (removed-in-3.x patterns)');
  try {
    sh('node scripts/check-ruby-compat.mjs', { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
    assert(true, 'Ruby surface has no removed-in-3.x patterns');
  } catch (err) {
    assert(false, `Ruby 3.x compat audit FAILED (see output above): ${err.message ?? err}`);
  }

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

  // ── Dist/source parity — catch stale dist (0.6.0 divergence class) ──
  console.log('\n[1.5/6] Checking dist/source parity (divergence guard)');
  {
    // Extract export names from a .ts source file and classify each as a
    // runtime VALUE or a TYPE. The distinction is load-bearing: `tsc` erases
    // types from the emitted .js, so a type-only export can NEVER appear in
    // dist/*.js — it lives in dist/*.d.ts. The AUD-001 regex extension folded
    // `export type` into the .js comparison, which made every type-only export
    // a guaranteed false "missing in dist" (0.8.0 publish gate). Values are
    // checked against the .js; types against the .d.ts.
    //
    // Regexes cover `export function/const/class/async function`,
    // `export type|interface Name`, `export { Name }`, `export type { Name }`,
    // and inline `export { value, type Foo }` (TS type modifiers), all with
    // optional `as Alias`. No full AST — sufficient to catch "added to source,
    // dist not rebuilt." Not captured: `export * from` or `export default`.
    function extractTsExports(srcPath) {
      if (!existsSync(srcPath)) return { values: [], types: [] };
      const src = readFileSync(srcPath, 'utf8');
      const values = [];
      const types = [];
      // export function / export const / export class / export async function
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
        values.push(m[1]);
      }
      // export type Name / export interface Name (standalone — not a { } block)
      for (const m of src.matchAll(/^export\s+(?:type|interface)\s+(?!\{)([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
        types.push(m[1]);
      }
      // export { Name } / export { Name as Alias } / export type { Name } / ...
      // A leading `export type {` marks the whole block type-only; otherwise an
      // entry may carry an inline `type` modifier. Route each name accordingly.
      // Capture the local name (before any `as`); skip `export default`.
      for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]+)\}/gm)) {
        const blockIsType = !!m[1];
        for (const entry of m[2].split(',')) {
          let e = entry.trim();
          if (!e) continue;
          let isType = blockIsType;
          if (/^type\s/.test(e)) { isType = true; e = e.replace(/^type\s+/, ''); }
          const local = e.split(/\s+as\s+/)[0].trim();
          if (!local || local === 'default') continue;
          (isType ? types : values).push(local);
        }
      }
      return { values, types };
    }

    const RUNNER_ROOT = join(ROOT, 'packages', 'cambium-runner');
    const criticalPairs = [
      {
        label: 'field_values',
        src: join(RUNNER_ROOT, 'src', 'correctors', 'field_values.ts'),
        dist: join(RUNNER_ROOT, 'dist', 'correctors', 'field_values.js'),
      },
      {
        label: 'network-guard',
        src: join(RUNNER_ROOT, 'src', 'tools', 'network-guard.ts'),
        dist: join(RUNNER_ROOT, 'dist', 'tools', 'network-guard.js'),
      },
      {
        label: 'registry',
        src: join(RUNNER_ROOT, 'src', 'tools', 'registry.ts'),
        dist: join(RUNNER_ROOT, 'dist', 'tools', 'registry.js'),
      },
      {
        label: 'wasm',
        src: join(RUNNER_ROOT, 'src', 'exec-substrate', 'wasm.ts'),
        dist: join(RUNNER_ROOT, 'dist', 'exec-substrate', 'wasm.js'),
      },
    ];

    let parityOk = true;
    // Compare a set of expected export names against a single dist artifact
    // (.js for values, .d.ts for types). Records a failure for any name absent.
    function checkArtifact(label, kind, names, artifactPath) {
      if (names.length === 0) return;
      if (!existsSync(artifactPath)) {
        console.log(`  ✗ ${label}: dist ${kind} file missing — ${artifactPath}`);
        failures.push(`dist diverged: ${label} ${kind} file missing`);
        parityOk = false;
        return;
      }
      const artifactSrc = readFileSync(artifactPath, 'utf8');
      const missing = names.filter((name) => !artifactSrc.includes(name));
      if (missing.length === 0) {
        console.log(`  ✓ ${label}: ${names.length}/${names.length} ${kind} exports present in dist`);
      } else {
        console.log(`  ✗ ${label}: ${kind} exports missing in dist — ${missing.join(', ')}`);
        failures.push(`dist diverged: ${label}: missing — ${missing.join(', ')}`);
        parityOk = false;
      }
    }

    for (const { label, src, dist } of criticalPairs) {
      const { values, types } = extractTsExports(src);
      if (values.length === 0 && types.length === 0) {
        console.log(`  ✓ ${label}: no exports to check (or file absent)`);
        continue;
      }
      // Runtime values survive to .js; types are erased and live in .d.ts.
      checkArtifact(label, 'value', values, dist);
      checkArtifact(label, 'type', types, dist.replace(/\.js$/, '.d.ts'));
    }
    assert(parityOk, 'dist matches source exports across all critical files');
  }

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

  // ── Run the full suite under Ruby 3.x on Alpine (RED-378) ────────────
  // The heaviest gate, last so the cheap checks fail fast first. Reproduces
  // the Alpine (Ruby 3.4) deploy target that RED-377 bit but the EOL-2.x dev
  // interpreter masked. Needs Docker; if it's unavailable the step fails (a
  // publish gate you can't run isn't a gate — run this on a Docker-capable
  // machine before publishing).
  console.log('\n[7/7] Running the full suite under Ruby 3.x on Alpine (Docker)');
  try {
    sh('node scripts/test-on-ruby.mjs', { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
    assert(true, 'full suite passes under Ruby 3.x on Alpine (RED-377 class caught)');
  } catch (err) {
    assert(false, `Ruby 3.x suite run FAILED (see output above): ${err.message ?? err}`);
  }
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
