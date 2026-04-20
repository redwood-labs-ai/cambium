#!/usr/bin/env node
// cambium doctor — environment diagnostics
// Checks common setup issues and prints actionable fixes.
// Exit code: 0 = all pass, 1 = failures found, 2 = errors during check.

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Framework Ruby scripts resolved relative to the CLI's own location
// (RED-274). `node_modules/`, `runs/`, `.env` stay cwd-relative — those
// are legitimately project-local.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(CLI_DIR, '..');

export function runDoctor() {
  process.exit(doctorMain());
}

function doctorMain() {
const CHECKS = [];
let passed = 0;
let failed = 0;
let warned = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result.ok) {
      passed++;
      CHECKS.push({ name, status: 'pass', detail: result.detail });
    } else if (result.warn) {
      warned++;
      CHECKS.push({ name, status: 'warn', detail: result.detail });
    } else {
      failed++;
      CHECKS.push({ name, status: 'fail', detail: result.detail });
    }
  } catch (err) {
    failed++;
    CHECKS.push({ name, status: 'fail', detail: err.message });
  }
}

function cmdVersion(cmd, minMajor) {
  try {
    const out = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8', timeout: 5000 }).trim();
    const m = out.match(/(\d+)\.(\d+)/);
    if (!m) return { ok: false, detail: `Could not parse version from: ${out.split('\n')[0]}` };
    const major = parseInt(m[1]);
    const minor = parseInt(m[2]);
    const ver = `${major}.${minor}`;
    if (major < minMajor) return { ok: false, detail: `${cmd} ${ver} (need >= ${minMajor}.0)` };
    return { ok: true, detail: `${cmd} ${ver}` };
  } catch {
    return { ok: false, detail: `${cmd} not found in PATH` };
  }
}

// ── Checks ──────────────────────────────────────────────────────────────

check('Node.js >= 18', () => cmdVersion('node', 18));

check('npm available', () => {
  try {
    const out = execSync('npm --version 2>&1', { encoding: 'utf8', timeout: 5000 }).trim();
    return { ok: true, detail: `npm ${out}` };
  } catch {
    return { ok: false, detail: 'npm not found in PATH' };
  }
});

check('Ruby available', () => {
  try {
    const out = execSync('ruby --version 2>&1', { encoding: 'utf8', timeout: 5000 }).trim();
    const m = out.match(/ruby (\d+\.\d+)/);
    if (!m) return { ok: false, detail: `Could not parse Ruby version: ${out}` };
    const ver = m[1];
    return { ok: true, detail: `ruby ${ver}` };
  } catch {
    return { ok: false, detail: 'Ruby not found. Install Ruby >= 3.0: https://www.ruby-lang.org/en/documentation/installation/' };
  }
});

check('Ruby gem: json', () => {
  try {
    execSync('gem list json 2>&1 | grep -q "^json "', { encoding: 'utf8', timeout: 5000 });
    return { ok: true, detail: 'json gem installed' };
  } catch {
    return { ok: false, detail: 'json gem not found. Run: gem install json' };
  }
});

check('Ruby compile.rb exists', () => {
  const path = resolve(FRAMEWORK_ROOT, 'ruby', 'cambium', 'compile.rb');
  if (existsSync(path)) return { ok: true, detail: path };
  return { ok: false, detail: `${path} not found. Framework install may be incomplete.` };
});

check('Ruby runtime.rb exists', () => {
  const path = resolve(FRAMEWORK_ROOT, 'ruby', 'cambium', 'runtime.rb');
  if (existsSync(path)) return { ok: true, detail: path };
  return { ok: false, detail: `${path} not found.` };
});

check('node_modules installed', () => {
  const path = join(process.cwd(), 'node_modules');
  if (existsSync(path) && statSync(path).isDirectory()) return { ok: true, detail: `node_modules/ exists` };
  return { ok: false, detail: 'node_modules/ not found. Run: npm install' };
});

check('tsx available', () => {
  try {
    const out = execSync('npx tsx --version 2>&1', { encoding: 'utf8', timeout: 10000 }).trim();
    return { ok: true, detail: `tsx ${out}` };
  } catch {
    return { ok: false, detail: 'tsx not available. Run: npm install' };
  }
});

check('runs/ writable', () => {
  const dir = join(process.cwd(), 'runs');
  try {
    if (!existsSync(dir)) {
      // Just check if we can create it
      const testDir = join(dir, '.doctor-test');
      execSync(`mkdir -p ${JSON.stringify(dir)}`, { timeout: 3000 });
    }
    const testFile = join(dir, '.doctor-test-write');
    writeFileSync(testFile, 'ok');
    unlinkSync(testFile);
    return { ok: true, detail: `runs/ is writable` };
  } catch (err) {
    return { ok: false, detail: `Cannot write to runs/: ${err.message}` };
  }
});

check('.env file', () => {
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) return { ok: true, detail: '.env found' };
  return { warn: true, detail: '.env not found. Create one with CAMBIUM_OMLX_BASEURL and CAMBIUM_OMLX_API_KEY (optional).' };
});

// RED-284: Genfile.toml presence. Catches the "I forgot to `cambium init`"
// case before a `cambium run` fails later with a more opaque error.
check('Genfile.toml (workspace or package)', () => {
  const genfilePath = join(process.cwd(), 'Genfile.toml');
  if (existsSync(genfilePath)) return { ok: true, detail: genfilePath };
  return { warn: true, detail: 'No Genfile.toml in cwd. If this is a new project, run `cambium init`.' };
});

check('CAMBIUM_OMLX_BASEURL reachable', () => {
  const base = process.env.CAMBIUM_OMLX_BASEURL ?? 'http://100.114.183.54:8080';
  const url = `${base.replace(/\/$/, '')}/health`;
  try {
    // Use a short timeout — we just want to know if it's up
    execSync(`curl -sf --max-time 3 ${JSON.stringify(url)} >/dev/null 2>&1`, { timeout: 5000 });
    return { ok: true, detail: `${base} reachable` };
  } catch {
    return { warn: true, detail: `${base} not reachable (timeout 3s). The runner can still use CAMBIUM_ALLOW_MOCK=1 for local dev.` };
  }
});

// ── Output ──────────────────────────────────────────────────────────────

const ICONS = { pass: '✓', fail: '✗', warn: '⚠' };
const COLORS = { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', reset: '\x1b[0m' };

console.log('\nCambium Doctor\n');

for (const c of CHECKS) {
  const color = COLORS[c.status];
  const icon = ICONS[c.status];
  console.log(`  ${color}${icon}${COLORS.reset}  ${c.name}`);
  if (c.detail) console.log(`      ${c.detail}`);
}

console.log('');
console.log(`  ${passed} passed, ${warned} warnings, ${failed} failures\n`);

if (failed > 0) {
  return 1;
}
return 0;
} // end doctorMain
