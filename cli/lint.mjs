#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

let errors = 0;
let warnings = 0;

function pass(msg) { console.log(`  ${PASS} ${msg}`); }
function fail(msg) { errors++; console.log(`  ${FAIL} ${msg}`); }
function warn(msg) { warnings++; console.log(`  ${WARN} ${msg}`); }

function fileExists(path, label) {
  if (existsSync(path)) { pass(label ?? path); return true; }
  fail(`${label ?? path} — not found`);
  return false;
}

// ── Parse TOML (minimal — handles our Genfile format) ─────────────────

function parseToml(text) {
  const result = {};
  let currentSection = result;
  let currentKey = '';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const parts = sectionMatch[1].split('.');
      currentSection = result;
      for (const p of parts) {
        if (!currentSection[p]) currentSection[p] = {};
        currentSection = currentSection[p];
      }
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      let val = kvMatch[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith('[')) {
        // Simple array parse
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      }
      currentSection[kvMatch[1]] = val;
    }
  }
  return result;
}

// ── Lint a package ────────────────────────────────────────────────────

function lintPackage(pkgDir) {
  const name = basename(pkgDir);
  console.log(`\n\x1b[1mPackage: ${name}\x1b[0m (${pkgDir})\n`);

  // 1. Genfile.toml
  const genfilePath = join(pkgDir, 'Genfile.toml');
  if (!fileExists(genfilePath, 'Genfile.toml')) {
    fail('Cannot lint without Genfile.toml');
    return;
  }

  const genfile = parseToml(readFileSync(genfilePath, 'utf8'));

  // 2. Package metadata
  if (genfile.package?.name) pass(`package.name = "${genfile.package.name}"`);
  else fail('package.name missing');

  if (genfile.package?.version) pass(`package.version = "${genfile.package.version}"`);
  else fail('package.version missing');

  // 3. Contracts
  if (genfile.types?.contracts) {
    const contracts = Array.isArray(genfile.types.contracts) ? genfile.types.contracts : [genfile.types.contracts];
    for (const c of contracts) {
      fileExists(join(pkgDir, c), `contracts: ${c}`);
    }
  } else {
    fail('types.contracts not declared');
  }

  // 4. Exported gens
  if (genfile.exports?.gens) {
    for (const [name, path] of Object.entries(genfile.exports.gens)) {
      if (fileExists(join(pkgDir, path), `exports.gens.${name}: ${path}`)) {
        // Check that the .cmb.rb file has a matching system prompt
        const content = readFileSync(join(pkgDir, path), 'utf8');
        const systemMatch = content.match(/system\s+:(\w+)/);
        if (systemMatch) {
          const sysName = systemMatch[1];
          const sysPath = join(pkgDir, 'app/systems', `${sysName}.system.md`);
          fileExists(sysPath, `  system :${sysName} → ${sysName}.system.md`);
        }
      }
    }
  } else {
    warn('No exports.gens declared');
  }

  // 5. Tests
  if (genfile.tests) {
    for (const [name, path] of Object.entries(genfile.tests)) {
      fileExists(join(pkgDir, path), `tests.${name}: ${path}`);
    }
  } else {
    fail('No tests declared');
  }

  // 6. Tool definitions ↔ implementations
  const toolsDir = join(pkgDir, 'app/tools');
  if (existsSync(toolsDir)) {
    const toolFiles = readdirSync(toolsDir).filter(f => f.endsWith('.tool.json'));
    for (const f of toolFiles) {
      const toolName = f.replace('.tool.json', '');
      pass(`tool definition: ${f}`);

      // Check for implementation
      // Look in src/tools/ relative to workspace root (not package)
      const implCandidates = [
        join(pkgDir, '../../src/tools', `${toolName}.ts`),
        join(pkgDir, 'src/tools', `${toolName}.ts`),
      ];
      const hasImpl = implCandidates.some(p => existsSync(p));
      if (hasImpl) pass(`  implementation: ${toolName}.ts`);
      else warn(`  no implementation found for tool "${toolName}" (check src/tools/${toolName}.ts)`);

      // Validate tool JSON structure
      try {
        const def = JSON.parse(readFileSync(join(toolsDir, f), 'utf8'));
        if (!def.name) fail(`  ${f}: missing "name"`);
        if (!def.inputSchema) fail(`  ${f}: missing "inputSchema"`);
        if (!def.outputSchema) fail(`  ${f}: missing "outputSchema"`);
        if (def.permissions) {
          const perms = def.permissions;
          if (perms.network) warn(`  ${f}: declares network access`);
          if (perms.filesystem) warn(`  ${f}: declares filesystem access`);
          if (perms.exec) warn(`  ${f}: declares exec access — review carefully`);
          if (perms.pure) pass(`  ${f}: pure (no side effects)`);
        } else {
          pass(`  ${f}: no permissions declared (treated as pure)`);
        }
      } catch (e) {
        fail(`  ${f}: invalid JSON — ${e.message}`);
      }
    }
  }

  // 7. Scan all .cmb.rb files (not just exported ones) for common issues
  const gensDir = join(pkgDir, 'app/gens');
  if (existsSync(gensDir)) {
    const allGens = readdirSync(gensDir).filter(f => f.endsWith('.cmb.rb'));
    for (const f of allGens) {
      const content = readFileSync(join(gensDir, f), 'utf8');

      // RED-210: `returns <Schema>` must resolve to an export in
      // contracts.ts. Upgrade from warn to fail — a typo here crashes
      // the runner with an obscure message, so catching it at lint
      // time is the whole point. The Ruby compiler also enforces this
      // at compile time; lint is the second line of defense for gens
      // that haven't been compiled yet.
      const returnsMatch = content.match(/returns\s+(\w+)/);
      if (returnsMatch && genfile.types?.contracts) {
        const schemaName = returnsMatch[1];
        const contracts = Array.isArray(genfile.types.contracts) ? genfile.types.contracts : [genfile.types.contracts];
        const availableExports = new Set();
        let foundIn = null;
        for (const c of contracts) {
          const contractsContent = readFileSync(join(pkgDir, c), 'utf8');
          const exportRe = /^\s*export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/gm;
          for (const m of contractsContent.matchAll(exportRe)) availableExports.add(m[1]);
          if (contractsContent.includes(`export const ${schemaName}`)) foundIn = c;
        }
        if (foundIn) {
          pass(`${f}: returns ${schemaName} (found in ${foundIn})`);
        } else {
          const sorted = [...availableExports].sort();
          const suggestion = sorted.find(e => e.toLowerCase() === schemaName.toLowerCase())
            ?? sorted.find(e => e.startsWith(schemaName) || schemaName.startsWith(e));
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
          fail(`${f}: returns ${schemaName} — not exported from ${contracts.join(', ')}.${hint}`);
        }
      }

      // Check uses references have tool definitions
      const usesMatches = [...content.matchAll(/uses\s+([^\n]+)/g)];
      for (const m of usesMatches) {
        const tools = m[1].match(/:(\w+)/g);
        if (tools) {
          for (const t of tools) {
            const toolName = t.slice(1);
            const toolPath = join(pkgDir, 'app/tools', `${toolName}.tool.json`);
            if (!existsSync(toolPath)) {
              warn(`${f}: uses :${toolName} — no tool definition at app/tools/${toolName}.tool.json`);
            }
          }
        }
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

export function runLint() {
  console.log('\x1b[1mCambium Lint\x1b[0m');

  // Find workspace root
  const wsGenfile = 'Genfile.toml';
  if (!existsSync(wsGenfile)) {
    console.error('No Genfile.toml found in current directory.');
    process.exit(2);
  }

  const ws = parseToml(readFileSync(wsGenfile, 'utf8'));
  const members = ws.workspace?.members;
  if (!members) {
    console.error('Genfile.toml has no [workspace] members.');
    process.exit(2);
  }

  // Resolve member globs (simple: just replace * with directory listing)
  const patterns = Array.isArray(members) ? members : [members];
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const dir = pattern.replace('/*', '');
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const pkgDir = join(dir, entry);
        if (existsSync(join(pkgDir, 'Genfile.toml'))) {
          lintPackage(pkgDir);
        }
      }
    } else {
      lintPackage(pattern);
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  if (errors === 0 && warnings === 0) {
    console.log(`\x1b[32m✓ All checks passed.\x1b[0m`);
  } else {
    if (errors > 0) console.log(`\x1b[31m${errors} error(s)\x1b[0m`);
    if (warnings > 0) console.log(`\x1b[33m${warnings} warning(s)\x1b[0m`);
  }

  process.exit(errors > 0 ? 1 : 0);
}
