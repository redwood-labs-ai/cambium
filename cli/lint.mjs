#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { detectWorkspaceShape, resolveMembers } from './workspace-shape.mjs';

// Engine-mode sentinel — RED-246 / RED-220. A directory marked with
// this file is a self-contained engine folder; lint scans siblings
// rather than walking app/<type>/ subdirs.
const ENGINE_SENTINEL = 'cambium.engine.json';

// Pack / pool / corrector / alias basename regex (RED-214/215/275/237).
// Shared across every engine-mode lint check that validates a name.
const NAME_REGEX = /^[a-z][a-z0-9_]*$/;

// Framework-builtin tool names — legitimate `uses :<name>` references in
// app-mode gens even when there's no `app/tools/<name>.tool.json`. The
// runtime registry resolves these from `packages/cambium-runner/src/
// builtin-tools/` at startup (RED-208); lint must too, otherwise every gen
// using the builtins emits a spurious warning (issue #168 / RED-218).
const BUILTIN_TOOL_NAMES = new Set([
'web_search',
'calculator',
'read_file',
'execute_code',
'web_extract',
]);

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

// Whole-line comment strip for the DSL regex scans below (issue #158).
// `.cmb.rb` files are Ruby, and the scaffolders' own worked examples —
// `# uses :web_search, :calculator`, `# ... use \`returns :SchemaName\`
// ...` — sit right next to the live declarations these regexes match
// against; an unanchored `uses\s+([^\n]+)` or `returns\s+:?([A-Z]\w*)`
// matches inside a comment exactly as well as in code. Drop any line
// whose first non-whitespace character is `#` before scanning. A real
// tokenizer is weight lint doesn't need, and stripping trailing `code #
// comment` risks mangling a `#` inside a string literal for a case
// nobody has reported — whole-line only.
function stripCommentLines(content) {
  return content
    .split('\n')
    .map((line) => (line.trim().startsWith('#') ? '' : line))
    .join('\n');
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

  // smol-toml throws on any spec violation (the hand-rolled parser it
  // replaced was total and never did) — a malformed member Genfile.toml
  // must not crash the whole run and skip every later member (AUD-217-01,
  // the shape-5 class this issue exists to eliminate).
  let genfile;
  try {
    genfile = parseToml(readFileSync(genfilePath, 'utf8'));
  } catch (e) {
    // smol-toml's message spans multiple lines (a code-frame under the
    // headline). Phase B's Recorder assumes one line per check
    // (AUD-217-10) — report only the headline here.
    const headline = String(e?.message ?? e).split('\n')[0];
    fail(`Genfile.toml — not valid TOML: ${headline}`);
    return;
  }

  // 2. Package metadata
  if (genfile.package?.name) pass(`package.name = "${genfile.package.name}"`);
  else fail('package.name missing');

  if (genfile.package?.version) pass(`package.version = "${genfile.package.version}"`);
  else fail('package.version missing');

  // 3. Contracts
  const declaredContracts = Array.isArray(genfile.types?.contracts)
    ? genfile.types.contracts
    : genfile.types?.contracts ? [genfile.types.contracts] : [];
  if (declaredContracts.length > 0) {
    for (const c of declaredContracts) {
      // smol-toml returns native TOML types; the hand-rolled parser it
      // replaced stringified every value, so `join(pkgDir, c)` never saw
      // a non-string before (AUD-217-04).
      if (typeof c !== 'string') {
        fail(`types.contracts: expected a string path, got ${typeof c}`);
        continue;
      }
      fileExists(join(pkgDir, c), `contracts: ${c}`);
    }
  } else {
    fail('types.contracts not declared');
  }

  // 4. Exported gens
  if (genfile.exports?.gens && Object.keys(genfile.exports.gens).length > 0) {
    for (const [name, path] of Object.entries(genfile.exports.gens)) {
      // See the types.contracts guard above (AUD-217-04) — smol-toml
      // returns native types, so a non-string entry must not reach join().
      if (typeof path !== 'string') {
        fail(`exports.gens.${name}: expected a string path, got ${typeof path}`);
        continue;
      }
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
  if (genfile.tests && Object.keys(genfile.tests).length > 0) {
    for (const [name, path] of Object.entries(genfile.tests)) {
      // See the types.contracts guard above (AUD-217-04).
      if (typeof path !== 'string') {
        fail(`tests.${name}: expected a string path, got ${typeof path}`);
        continue;
      }
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

      // Check for implementation. Post-RED-209 the canonical location for
      // an app-tool handler is the sibling `<name>.tool.ts` (auto-discovered
      // by the registry); the legacy `src/tools/<name>.ts` paths predate
      // that and survived only because no one had pruned them. Post-RED-242
      // those stale paths now also point under packages/cambium-runner/.
      const implCandidates = [
        join(toolsDir, `${toolName}.tool.ts`),                                          // RED-209 sibling
        join(pkgDir, '../cambium-runner/src/tools', `${toolName}.ts`),                  // legacy framework-internal
        join(pkgDir, 'src/tools', `${toolName}.ts`),                                    // legacy package-local
      ];
      const hasImpl = implCandidates.some(p => existsSync(p));
      if (hasImpl) pass(`  implementation: ${toolName}.ts`);
      else warn(`  no implementation found for tool "${toolName}" (check ${toolsDir}/${toolName}.tool.ts)`);

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

  // 6b. Action definitions ↔ implementations (RED-212, added RED-284).
  // Mirrors the tool block above — .action.json + sibling .action.ts.
  const actionsDir = join(pkgDir, 'app/actions');
  if (existsSync(actionsDir)) {
    const actionFiles = readdirSync(actionsDir).filter(f => f.endsWith('.action.json'));
    for (const f of actionFiles) {
      const actionName = f.replace('.action.json', '');
      pass(`action definition: ${f}`);

      const implPath = join(actionsDir, `${actionName}.action.ts`);
      if (existsSync(implPath)) pass(`  implementation: ${actionName}.action.ts`);
      else warn(`  no implementation found for action "${actionName}" (check ${actionsDir}/${actionName}.action.ts)`);

      try {
        const def = JSON.parse(readFileSync(join(actionsDir, f), 'utf8'));
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

  // 6c. Policy packs (RED-214, lint added RED-284).
  // Basename regex guard, presence check. Body validation happens at
  // compile time (PolicyPack.load).
  const policiesDir = join(pkgDir, 'app/policies');
  if (existsSync(policiesDir)) {
    const SYMBOL_REGEX = /^[a-z][a-z0-9_]*$/;
    const policyFiles = readdirSync(policiesDir).filter(f => f.endsWith('.policy.rb'));
    for (const f of policyFiles) {
      const packName = f.replace('.policy.rb', '');
      if (!SYMBOL_REGEX.test(packName)) {
        fail(`policy pack name "${packName}" (${f}) must match /^[a-z][a-z0-9_]*$/ (RED-214 path-traversal guard)`);
      } else {
        pass(`policy pack: ${f}`);
      }
    }
  }

  // 6d. Memory pools (RED-215, lint added RED-284).
  const poolsDir = join(pkgDir, 'app/memory_pools');
  if (existsSync(poolsDir)) {
    const SYMBOL_REGEX = /^[a-z][a-z0-9_]*$/;
    const poolFiles = readdirSync(poolsDir).filter(f => f.endsWith('.pool.rb'));
    for (const f of poolFiles) {
      const poolName = f.replace('.pool.rb', '');
      if (!SYMBOL_REGEX.test(poolName)) {
        fail(`memory pool name "${poolName}" (${f}) must match /^[a-z][a-z0-9_]*$/ (RED-215 path-traversal guard)`);
      } else {
        pass(`memory pool: ${f}`);
      }
    }
  }

  // 6e. App correctors (RED-275, lint added RED-284).
  // Basename regex + export-name match (the loader at runtime requires
  // the module to export a function matching the basename).
  const correctorsDir = join(pkgDir, 'app/correctors');
  if (existsSync(correctorsDir)) {
    const SYMBOL_REGEX = /^[a-z][a-z0-9_]*$/;
    const correctorFiles = readdirSync(correctorsDir).filter(f => f.endsWith('.corrector.ts'));
    for (const f of correctorFiles) {
      const name = f.replace('.corrector.ts', '');
      if (!SYMBOL_REGEX.test(name)) {
        fail(`corrector name "${name}" (${f}) must match /^[a-z][a-z0-9_]*$/ (RED-275)`);
        continue;
      }
      pass(`corrector: ${f}`);

      const body = readFileSync(join(correctorsDir, f), 'utf8');
      // Loose match — handles `export const <name>` and `export function <name>`.
      const exportRe = new RegExp(`export\\s+(?:const|function|let)\\s+${name}\\b`);
      if (exportRe.test(body)) {
        pass(`  exports "${name}" (matches basename)`);
      } else {
        fail(`  ${f}: must export "${name}" matching the basename (RED-275 loader requirement)`);
      }
    }
  }

  // 6f. Custom providers (RED-393, lint added 0.6.0).
  // Basename = model-id prefix → must match the regex AND the file must
  // `export default`. The registry's loadFromDir enforces the same regex +
  // an export-name-must-match-basename rule at load time; lint catches the
  // file-shape issues before the first model dispatch (providers fail at
  // dispatch, not at startup, so the runtime error is one indirection away).
  const providersDir = join(pkgDir, 'app/providers');
  if (existsSync(providersDir)) {
    const SYMBOL_REGEX = /^[a-z][a-z0-9_]*$/;
    const providerFiles = readdirSync(providersDir).filter(
      f => (f.endsWith('.ts') || f.endsWith('.js'))
        && !f.endsWith('.d.ts') && !f.endsWith('.test.ts') && !f.endsWith('.test.js'),
    );
    for (const f of providerFiles) {
      const name = f.replace(/\.(ts|js)$/, '');
      if (!SYMBOL_REGEX.test(name)) {
        fail(`provider file name "${name}" (${f}) must match /^[a-z][a-z0-9_]*$/ — the basename becomes the model-id prefix (RED-393)`);
        continue;
      }
      pass(`provider: ${f}`);

      const body = readFileSync(join(providersDir, f), 'utf8');
      if (!/export\s+default/.test(body)) {
        fail(`  ${f}: must \`export default\` a CambiumProvider (RED-393 loader requirement)`);
      }
      // Honesty: if a `name: '...'` config field is present it must equal the
      // basename (the loader rejects a mismatch — name derives from filename).
      // Anchor to an object-literal token position (after `{`, `,`, or a line
      // break) so a `name: '...'` inside a comment or prose doesn't trip a
      // false failure. The runtime loader (registry.loadFromDir) is the
      // authoritative check; this is the early-warning.
      const nameField = body.match(/[\n,{]\s*name:\s*['"]([a-z][a-z0-9_]*)['"]/);
      if (nameField && nameField[1] !== name) {
        fail(`  ${f}: declares name '${nameField[1]}' but the filename requires '${name}' — rename the file or drop the name field (RED-393)`);
      }
    }
  }

  // 6g. Config files (RED-237 + RED-239, lint added RED-284).
  // Whitelist of allowed names; presence check. Syntax validation is
  // deferred to the Ruby compiler's own load path — lint just catches
  // typos like `model.rb` or `memory-policy.rb`.
  const configDir = join(pkgDir, 'app/config');
  if (existsSync(configDir)) {
    const allowedConfigs = new Set(['models.rb', 'memory_policy.rb']);
    const configFiles = readdirSync(configDir).filter(f => f.endsWith('.rb'));
    for (const f of configFiles) {
      if (allowedConfigs.has(f)) {
        pass(`config: ${f}`);
      } else {
        warn(`unknown config file: ${f} (expected one of: ${[...allowedConfigs].join(', ')})`);
      }
    }
  }

  // 7. Scan all .cmb.rb files (not just exported ones) for common issues
  const gensDir = join(pkgDir, 'app/gens');
  if (existsSync(gensDir)) {
    const allGens = readdirSync(gensDir).filter(f => f.endsWith('.cmb.rb'));
    for (const f of allGens) {
      const content = readFileSync(join(gensDir, f), 'utf8');
      // Comment-stripped view for the regex scans below (issue #158):
      // the scaffolders' own commented-out examples (`# uses :…`,
      // `# ... returns :SchemaName ...`) sit right next to the live
      // declarations and must not be matched as if they were live.
      const scan = stripCommentLines(content);

      // RED-210: `returns <Schema>` must resolve to an export in
      // contracts.ts. Upgrade from warn to fail — a typo here crashes
      // the runner with an obscure message, so catching it at lint
      // time is the whole point. The Ruby compiler also enforces this
      // at compile time; lint is the second line of defense for gens
      // that haven't been compiled yet.
      // Symbol form only: an uppercase-initial name, optionally with a
      // leading `:` (both `returns Foo` and `returns :Foo` are legal).
      // Block-form `returns do … end` (RED-419) compiles the schema
      // inline into the IR and never consults contracts.ts, and
      // lowercase prose in comments ("…returns a structured…") must not
      // trip the check (issues #167 / #160).
      const returnsMatch = scan.match(/^\s*returns\s+:?([A-Z]\w*)/m);
      if (returnsMatch && genfile.types?.contracts) {
        const schemaName = returnsMatch[1];
        const contracts = Array.isArray(genfile.types.contracts) ? genfile.types.contracts : [genfile.types.contracts];
        const availableExports = new Set();
        let foundIn = null;
        for (const c of contracts) {
          // See the types.contracts guard in section 3 above (AUD-217-04)
          // — this is a second, independent consumption site for the
          // same array and needs the same guard (AUD-217-09).
          if (typeof c !== 'string') {
            fail(`types.contracts: expected a string path, got ${typeof c}`);
            continue;
          }
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

      // Check uses references have tool definitions. App-tool defs live
// under `app/tools/<name>.tool.json`; framework builtins (web_search,
// calculator, read_file, execute_code, web_extract) are resolved by the
// runtime registry from `packages/cambium-runner/src/builtin-tools/` and
// don't need a local definition. Don't warn on those — they're legitimate
// refs in any app gen (issue #168 / RED-218).
      const usesMatches = [...scan.matchAll(/uses\s+([^\n]+)/g)];
      for (const m of usesMatches) {
        const tools = m[1].match(/:(\w+)/g);
        if (tools) {
          for (const t of tools) {
            const toolName = t.slice(1);
            if (BUILTIN_TOOL_NAMES.has(toolName)) continue;
            const toolPath = join(pkgDir, 'app/tools', `${toolName}.tool.json`);
            if (!existsSync(toolPath)) {
              warn(`${f}: uses :${toolName} — no tool definition at app/tools/${toolName}.tool.json (ok if framework builtin)`);
            }
          }
        }
      }
    }
  }

  // 8. Scan all .pipeline.rb files for common issues (RED-381 Phase G.2).
  //
  // The Ruby compiler (PipelineCompiler.validate_file_basename! +
  // resolve_methods_to_compile + Validator) is the strict gate; lint is
  // the before-you-compile heads-up that catches the same classes of
  // mistake with friendlier framing.
  const pipelinesDir = join(pkgDir, 'app/pipelines');
  if (existsSync(pipelinesDir)) {
    const pipelineFiles = readdirSync(pipelinesDir).filter(f => f.endsWith('.pipeline.rb'));
    for (const f of pipelineFiles) {
      const content = readFileSync(join(pipelinesDir, f), 'utf8');

      // 8a. File basename regex (same /^[a-z][a-z0-9_]*$/ stance every
      // other named-symbol surface uses).
      const basename = f.replace(/\.pipeline\.rb$/, '');
      if (!/^[a-z][a-z0-9_]*$/.test(basename)) {
        fail(
          `app/pipelines/${f}: basename '${basename}' must match /^[a-z][a-z0-9_]*$/ ` +
          `(snake_case, e.g. ci_review.pipeline.rb).`,
        );
      }

      // 8b. Class must inherit from Pipeline (the runtime gates this
      // via registry detection in compile.rb; lint catches the typo
      // before compile spawns Ruby).
      if (!/class\s+\w+\s*<\s*Pipeline\b/.test(content)) {
        fail(
          `app/pipelines/${f}: must declare 'class <Name> < Pipeline' — ` +
          `inherit from the Pipeline base class (RED-374).`,
        );
      }

      // 8c. 1:1 stance — exactly one `def`. Multiple methods would also
      // fail at compile time with a clearer message, but a lint heads-up
      // is more user-friendly. Stop counting once a `private` or
      // `protected` keyword is seen — later helpers are not public
      // methods (AUD-217-06 widens this from `private`-only). Strip
      // `=begin`/`=end` block comments first: a documented example
      // containing a bare `private` line must not truncate the real
      // scan and silently drop every later `def`.
      const noBlockComments = content.replace(/^=begin\b[\s\S]*?^=end\b.*$/gm, '');
      // The inline `private def name` / `protected def name` form needs
      // no separate handling here: unlike the bare keyword, it marks
      // only that one method and doesn't change visibility for what
      // follows, and the `def`-matching regex below already only matches
      // a `def` that starts the line, so the modified line is excluded
      // without truncating anything after it.
      const privateIdx = noBlockComments.search(/^\s*(private|protected)\s*$/m);
      const publicScan = privateIdx === -1 ? noBlockComments : noBlockComments.slice(0, privateIdx);
      const defLines = [...publicScan.matchAll(/^\s*def\s+([a-z_][a-z0-9_]*)/gm)];
      if (defLines.length === 0) {
        fail(
          `app/pipelines/${f}: declares no entry method. ` +
          `Pipelines need exactly one public 'def <name>(<input>); end' (1:1 stance per RED-374).`,
        );
      } else if (defLines.length > 1) {
        const names = defLines.map((m) => `:${m[1]}`).join(', ');
        fail(
          `app/pipelines/${f}: declares ${defLines.length} public methods (${names}). ` +
          `Pipelines are 1:1 — one class, one method, one chain. ` +
          `Split into one Pipeline class per chain.`,
        );
      }

      // 8d. Input schema (best-effort) — every input :name, schema: X
      // should resolve to a contracts.ts export. Mirrors the gen-side
      // returns check above.
      const inputMatches = [...content.matchAll(/input\s+:[a-z_][a-z0-9_]*\s*,\s*schema:\s*(\w+)/g)];
      if (inputMatches.length > 0 && genfile.types?.contracts) {
        const contracts = Array.isArray(genfile.types.contracts) ? genfile.types.contracts : [genfile.types.contracts];
        const availableExports = new Set();
        for (const c of contracts) {
          // See the types.contracts guard in section 3 above (AUD-217-04)
          // — a fifth independent consumption site for the same array
          // needing the same guard (AUD-217-09).
          if (typeof c !== 'string') {
            fail(`types.contracts: expected a string path, got ${typeof c}`);
            continue;
          }
          const cc = readFileSync(join(pkgDir, c), 'utf8');
          const exportRe = /^\s*export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/gm;
          for (const m of cc.matchAll(exportRe)) availableExports.add(m[1]);
        }
        for (const m of inputMatches) {
          const schemaName = m[1];
          if (!availableExports.has(schemaName)) {
            const suggestion = [...availableExports]
              .find((e) => e.toLowerCase() === schemaName.toLowerCase());
            const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
            fail(
              `app/pipelines/${f}: input schema ${schemaName} not exported from ` +
              `${contracts.join(', ')}.${hint}`,
            );
          }
        }
      }
    }
    if (pipelineFiles.length > 0) {
      pass(`app/pipelines/: ${pipelineFiles.length} pipeline file${pipelineFiles.length === 1 ? '' : 's'} scanned`);
    }
  }
}

// ── Engine-mode sentinel detection ────────────────────────────────────

// Walk up from cwd looking for an engine folder. Returns the directory
// containing cambium.engine.json, or null. Stops at the filesystem root.
// No package.json boundary (matches `cambium run` — a user invoking
// lint from inside a host project's engine folder should still lint it).
function resolveEngineDir(cwd) {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ENGINE_SENTINEL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Engine-folder lint ─────────────────────────────────────────────────
//
// Engine mode (RED-220 / RED-246) keeps every surface as a **sibling**
// of the gen file. Lint walks the engine folder with suffix-based
// filters and runs the same regex + JSON-shape checks that `lintPackage`
// runs against `app/<type>/` directories.
//
// Unlike app-mode lint, engine mode has one gen per folder (the design
// note calls this out — a folder with multiple gens has outgrown engine
// mode). We still walk every `.cmb.rb` we find, which supports the
// multi-gen case for completeness.

function lintEngine(engineDir) {
  const name = basename(engineDir);
  console.log(`\n\x1b[1mEngine: ${name}\x1b[0m (${engineDir})\n`);

  // 1. Sentinel shape
  const sentinelPath = join(engineDir, ENGINE_SENTINEL);
  try {
    const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    if (sentinel.name) pass(`${ENGINE_SENTINEL}.name = "${sentinel.name}"`);
    else warn(`${ENGINE_SENTINEL}: missing "name"`);
    if (sentinel.version) pass(`${ENGINE_SENTINEL}.version = "${sentinel.version}"`);
    else warn(`${ENGINE_SENTINEL}: missing "version"`);
  } catch (e) {
    fail(`${ENGINE_SENTINEL}: invalid JSON — ${e.message}`);
    return;
  }

  const entries = readdirSync(engineDir);

  // 2. Schemas — parse schemas.ts for top-level exports, we'll validate
  //    `returns <Schema>` against these below.
  const availableSchemas = new Set();
  const schemasPath = join(engineDir, 'schemas.ts');
  const hasSchemasFile = existsSync(schemasPath);
  if (hasSchemasFile) {
    pass('schemas.ts');
    const content = readFileSync(schemasPath, 'utf8');
    for (const m of content.matchAll(/^\s*export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/gm)) {
      availableSchemas.add(m[1]);
    }
  } else {
    warn('no schemas.ts (required for `returns <Schema>` validation)');
  }

  // 3. Tools — *.tool.json must have sibling *.tool.ts + required fields.
  const toolFiles = entries.filter(f => f.endsWith('.tool.json'));
  const knownTools = new Set();
  for (const f of toolFiles) {
    const toolName = f.replace('.tool.json', '');
    pass(`tool: ${f}`);
    knownTools.add(toolName);
    try {
      const def = JSON.parse(readFileSync(join(engineDir, f), 'utf8'));
      if (!def.name) fail(`  ${f}: missing "name"`);
      if (!def.inputSchema) fail(`  ${f}: missing "inputSchema"`);
      if (!def.outputSchema) fail(`  ${f}: missing "outputSchema"`);
      if (def.permissions?.network) warn(`  ${f}: declares network access`);
      if (def.permissions?.filesystem) warn(`  ${f}: declares filesystem access`);
      if (def.permissions?.exec) warn(`  ${f}: declares exec access — review carefully`);
    } catch (e) {
      fail(`  ${f}: invalid JSON — ${e.message}`);
    }
    if (!existsSync(join(engineDir, `${toolName}.tool.ts`))
        && !existsSync(join(engineDir, `${toolName}.tool.js`))) {
      warn(`  no implementation for tool "${toolName}" (expected ${toolName}.tool.ts)`);
    }
  }

  // 4. Actions — same shape as tools (RED-212).
  const actionFiles = entries.filter(f => f.endsWith('.action.json'));
  const knownActions = new Set();
  for (const f of actionFiles) {
    const actionName = f.replace('.action.json', '');
    pass(`action: ${f}`);
    knownActions.add(actionName);
    try {
      const def = JSON.parse(readFileSync(join(engineDir, f), 'utf8'));
      if (!def.name) fail(`  ${f}: missing "name"`);
      if (!def.inputSchema) fail(`  ${f}: missing "inputSchema"`);
    } catch (e) {
      fail(`  ${f}: invalid JSON — ${e.message}`);
    }
    if (!existsSync(join(engineDir, `${actionName}.action.ts`))
        && !existsSync(join(engineDir, `${actionName}.action.js`))) {
      warn(`  no implementation for action "${actionName}"`);
    }
  }

  // 5. Correctors — basename regex + export-name match (same as
  //    packages/cambium-runner/src/correctors/app-loader.ts enforces).
  const correctorFiles = entries.filter(f => f.endsWith('.corrector.ts'));
  const knownCorrectors = new Set();
  for (const f of correctorFiles) {
    const correctorName = f.replace('.corrector.ts', '');
    if (!NAME_REGEX.test(correctorName)) {
      fail(`corrector name "${correctorName}" (${f}) must match ${NAME_REGEX}`);
      continue;
    }
    pass(`corrector: ${f}`);
    knownCorrectors.add(correctorName);
    const body = readFileSync(join(engineDir, f), 'utf8');
    const exportRe = new RegExp(`export\\s+(?:const|function|let)\\s+${correctorName}\\b`);
    if (!exportRe.test(body)) {
      fail(`  ${f}: must export "${correctorName}" matching the basename`);
    }
  }

  // 6. Policy packs — name regex (RED-214).
  const policyFiles = entries.filter(f => f.endsWith('.policy.rb'));
  const knownPolicies = new Set();
  for (const f of policyFiles) {
    const policyName = f.replace('.policy.rb', '');
    if (!NAME_REGEX.test(policyName)) {
      fail(`policy pack name "${policyName}" (${f}) must match ${NAME_REGEX}`);
    } else {
      pass(`policy pack: ${f}`);
      knownPolicies.add(policyName);
    }
  }

  // 7. Memory pools — name regex (RED-215).
  const poolFiles = entries.filter(f => f.endsWith('.pool.rb'));
  const knownPools = new Set();
  for (const f of poolFiles) {
    const poolName = f.replace('.pool.rb', '');
    if (!NAME_REGEX.test(poolName)) {
      fail(`memory pool name "${poolName}" (${f}) must match ${NAME_REGEX}`);
    } else {
      pass(`memory pool: ${f}`);
      knownPools.add(poolName);
    }
  }

  // RED-302: log profiles under app/log_profiles/*.log_profile.rb.
  const logProfileFiles = entries.filter(f => f.endsWith('.log_profile.rb'));
  const knownLogProfiles = new Set();
  for (const f of logProfileFiles) {
    const profileName = f.replace('.log_profile.rb', '');
    if (!NAME_REGEX.test(profileName)) {
      fail(`log profile name "${profileName}" (${f}) must match ${NAME_REGEX}`);
    } else {
      pass(`log profile: ${f}`);
      knownLogProfiles.add(profileName);
    }
  }
  // Framework-builtin log destinations — legitimate inline references.
  const BUILTIN_LOG_DESTINATIONS = new Set(['stdout', 'http_json', 'datadog']);

  // 7b. Custom providers (RED-424): engine-mode `<prefix>.provider.ts` siblings.
  // Same shape checks as the app-mode block in lintPackage — basename = model-id
  // prefix, must `export default`, and any `name:` field must agree with the
  // basename. The runner's registerFromDir is the authoritative loader (shared
  // by both discovery paths); this is the early-warning before first dispatch.
  const providerSiblings = entries.filter(
    f => f.endsWith('.provider.ts') && !f.endsWith('.provider.d.ts') && !f.endsWith('.provider.test.ts'),
  );
  for (const f of providerSiblings) {
    const providerName = f.slice(0, -'.provider.ts'.length);
    if (!NAME_REGEX.test(providerName)) {
      fail(`provider file name "${providerName}" (${f}) must match ${NAME_REGEX} — the basename becomes the model-id prefix (RED-393/RED-424)`);
      continue;
    }
    pass(`provider: ${f}`);
    const body = readFileSync(join(engineDir, f), 'utf8');
    if (!/export\s+default/.test(body)) {
      fail(`  ${f}: must \`export default\` a CambiumProvider (RED-393 loader requirement)`);
    }
    const nameField = body.match(/[\n,{]\s*name:\s*['"]([a-z][a-z0-9_]*)['"]/);
    if (nameField && nameField[1] !== providerName) {
      fail(`  ${f}: declares name '${nameField[1]}' but the filename requires '${providerName}' — rename the file or drop the name field (RED-393)`);
    }
  }

  // 8. Gen validation — walk every .cmb.rb and cross-check references.
  //    Framework-builtin tool / corrector names are legitimate refs too;
  //    lint only warns on unknown names (not fails) since the runner has
  //    the authoritative registry and a misspelled builtin will fail
  //    loudly at runtime.
  const genFiles = entries.filter(f => f.endsWith('.cmb.rb'));
  if (genFiles.length === 0) {
    warn('no .cmb.rb files in engine folder');
  } else if (genFiles.length > 1) {
    warn(`engine folder has ${genFiles.length} gens — the "one folder, one gen" convention is broken`);
  }
  for (const f of genFiles) {
    const content = readFileSync(join(engineDir, f), 'utf8');
    // Comment-stripped view for the regex scans below (issue #158): the
    // engine scaffold's own `# uses :web_search, :calculator` / `#
    // corrects :math` examples must not be matched as if they were live.
    const scan = stripCommentLines(content);

    // returns <Schema>
    const returnsMatch = scan.match(/^\s*returns\s+([A-Z]\w*)/m);
    if (returnsMatch) {
      const schemaName = returnsMatch[1];
      if (availableSchemas.size > 0) {
        if (availableSchemas.has(schemaName)) {
          pass(`${f}: returns ${schemaName} (found in schemas.ts)`);
        } else {
          const sorted = [...availableSchemas].sort();
          const suggestion = sorted.find(s => s.toLowerCase() === schemaName.toLowerCase());
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
          fail(`${f}: returns ${schemaName} — not exported from schemas.ts.${hint}`);
        }
      } else if (hasSchemasFile) {
        // schemas.ts exists but the `export const` scan (issue #210's
        // territory, not this fix's) recognized no top-level exports —
        // e.g. `const X = ...; export { X }`. The schema may genuinely be
        // exported; lint just can't see it, so it must not claim a miss
        // (that misdirection is exactly what the audit flagged about the
        // compiler's own error message — issue #211).
        warn(`${f}: returns ${schemaName} — schemas.ts has no \`export const\` declarations lint recognizes, could not validate this reference`);
      }
      // else: no schemas.ts at all — already warned above (line ~556).
    }

    // system :name → <name>.system.md sibling
    const systemMatch = scan.match(/^\s*system\s+:(\w+)/m);
    if (systemMatch) {
      const sysName = systemMatch[1];
      if (existsSync(join(engineDir, `${sysName}.system.md`))) {
        pass(`${f}: system :${sysName} → ${sysName}.system.md`);
      } else {
        fail(`${f}: system :${sysName} — no sibling ${sysName}.system.md`);
      }
    }

    // uses :tool — warn if no sibling .tool.json (framework builtins OK).
    for (const m of scan.matchAll(/uses\s+([^\n]+)/g)) {
      const tools = m[1].match(/:(\w+)/g) ?? [];
      for (const t of tools) {
        const toolName = t.slice(1);
        if (!knownTools.has(toolName)) {
          warn(`${f}: uses :${toolName} — no sibling ${toolName}.tool.json (ok if framework builtin)`);
        }
      }
    }

    // corrects :name — warn if no sibling .corrector.ts (framework builtins OK).
    for (const m of scan.matchAll(/corrects\s+([^\n]+)/g)) {
      const correctors = m[1].match(/:(\w+)/g) ?? [];
      for (const c of correctors) {
        const cname = c.slice(1);
        if (!knownCorrectors.has(cname)) {
          warn(`${f}: corrects :${cname} — no sibling ${cname}.corrector.ts (ok if framework builtin)`);
        }
      }
    }

    // RED-302: log :name — either a framework built-in destination
    // (stdout/http_json/datadog), a profile file, or an app log-plugin
    // (app/logs/<name>.log.ts). Warn on unknown names; don't fail
    // because the runtime registry is authoritative.
    for (const m of scan.matchAll(/^\s*log\s+:(\w+)/gm)) {
      const logName = m[1];
      if (
        !BUILTIN_LOG_DESTINATIONS.has(logName) &&
        !knownLogProfiles.has(logName)
      ) {
        warn(`${f}: log :${logName} — no sibling ${logName}.log_profile.rb and not a framework built-in (ok if an app log plugin at app/logs/${logName}.log.ts)`);
      } else if (knownLogProfiles.has(logName)) {
        pass(`${f}: log :${logName} → ${logName}.log_profile.rb`);
      }
    }

    // RED-305: cron primitive — check that named-vocab symbols match
    // the framework set. Raw crontab expressions are not validated here
    // (the Ruby compiler catches malformed ones). We also check the
    // compile-time pairing: memory scope :schedule requires at least
    // one cron on the same gen. Purely lint-level — the Ruby compiler
    // is authoritative.
    const CRON_NAMED_VOCAB = new Set(['daily', 'hourly', 'weekly', 'weekdays', 'every_minute']);
    const cronNamedDecls = [...scan.matchAll(/^\s*cron\s+:(\w+)/gm)];
    for (const m of cronNamedDecls) {
      const vocab = m[1];
      if (!CRON_NAMED_VOCAB.has(vocab)) {
        warn(`${f}: cron :${vocab} — not in the framework named vocabulary (${[...CRON_NAMED_VOCAB].map(v => ':' + v).join(', ')}). Use a raw crontab string instead.`);
      }
    }
    const hasCron = cronNamedDecls.length > 0 || /^\s*cron\s+"/m.test(scan);
    const scheduleScoped = /memory\s+:[a-z][a-z0-9_]*[^\n]*scope:\s*:schedule\b/m.test(scan);
    if (scheduleScoped && !hasCron) {
      fail(`${f}: memory scope: :schedule declared but no cron found — RED-305 requires at least one cron declaration on the gen.`);
    } else if (scheduleScoped && hasCron) {
      pass(`${f}: memory scope :schedule paired with cron (RED-305)`);
    }

    // security :pack → sibling <pack>.policy.rb.
    const secMatch = scan.match(/^\s*security\s+:(\w+)\s*$/m);
    if (secMatch) {
      const pack = secMatch[1];
      if (!knownPolicies.has(pack)) {
        fail(`${f}: security :${pack} — no sibling ${pack}.policy.rb`);
      } else {
        pass(`${f}: security :${pack} → ${pack}.policy.rb`);
      }
    }

    // budget :pack — same.
    const budgetMatch = scan.match(/^\s*budget\s+:(\w+)\s*$/m);
    if (budgetMatch) {
      const pack = budgetMatch[1];
      if (!knownPolicies.has(pack)) {
        fail(`${f}: budget :${pack} — no sibling ${pack}.policy.rb`);
      }
    }

    // memory :x, scope: :pool_name → sibling <pool_name>.pool.rb.
    for (const m of scan.matchAll(/scope:\s*:(\w+)/g)) {
      const pool = m[1];
      // Skip the reserved scope names — those don't map to pools.
      if (pool === 'session' || pool === 'global' || pool === 'schedule' || pool === 'pipeline_run') continue;
      if (!knownPools.has(pool)) {
        fail(`${f}: memory scope :${pool} — no sibling ${pool}.pool.rb`);
      }
    }

    // action :name inside trigger blocks → sibling .action.json.
    for (const m of scan.matchAll(/\baction\s+:(\w+)/g)) {
      const a = m[1];
      if (!knownActions.has(a)) {
        warn(`${f}: action :${a} — no sibling ${a}.action.json (ok if framework builtin)`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

export function runLint() {
  console.log('\x1b[1mCambium Lint\x1b[0m');

  // RED-289: engine-folder detection wins. A user invoking `cambium lint`
  // from inside an engine folder wants the engine linted, not the host
  // workspace the engine happens to live inside.
  const engineDir = resolveEngineDir(process.cwd());
  if (engineDir) {
    lintEngine(engineDir);
    console.log(`\n${'─'.repeat(40)}`);
    if (errors === 0 && warnings === 0) {
      console.log(`\x1b[32m✓ All checks passed.\x1b[0m`);
    } else {
      if (errors > 0) console.log(`\x1b[31m${errors} error(s)\x1b[0m`);
      if (warnings > 0) console.log(`\x1b[33m${warnings} warning(s)\x1b[0m`);
    }
    process.exit(errors > 0 ? 1 : 0);
  }

  // Find the workspace anchor from cwd. Dispatches on shape:
  //   [workspace] → walk members, lint each
  //   [package]   → lint the single package at cwd (flat layout; RED-286)
  const shape = detectWorkspaceShape(process.cwd());
  if (!shape) {
    console.error('No Genfile.toml or cambium.engine.json found at cwd or any ancestor.');
    process.exit(2);
  }

  // When detection walks up (e.g. cwd is deep inside a monorepo), lint
  // always operates on the anchor it finds — not cwd — so a
  // `cambium lint` from inside packages/cambium/src/ still lints the
  // package's Genfile.
  const rootGenfile = join(shape.workspaceRoot, 'Genfile.toml');

  if (shape.shape === 'package') {
    // Flat [package] layout: the anchor IS the one package.
    lintPackage(shape.workspaceRoot);
  } else {
    // [workspace] layout: walk members. The legacy packages/cambium/-only
    // fallback (no Genfile at root) lints that single package too.
    if (!existsSync(rootGenfile)) {
      // Legacy fallback: detectWorkspaceShape returned 'workspace' via the
      // packages/cambium/ subdir path, without a Genfile at the root.
      lintPackage(shape.appPkgRoot);
    } else {
      // The root workspace Genfile is already validated by
      // classifyGenfile (called inside detectWorkspaceShape above), so
      // this parse is not reachable with malformed input today — guard
      // it anyway rather than rely on an ordering nobody wrote down
      // (AUD-217-01).
      let ws;
      try {
        ws = parseToml(readFileSync(rootGenfile, 'utf8'));
      } catch (e) {
        console.error(`${rootGenfile} — invalid TOML: ${e?.message ?? String(e)}`);
        process.exit(2);
      }
      const members = ws.workspace?.members;
      if (!members) {
        console.error(`${rootGenfile} has [workspace] without members.`);
        process.exit(2);
      }
      const { accepted, missingGenfile, rejected } = resolveMembers(shape.workspaceRoot, members);
      // Report rejected members first, under their own heading — not
      // after the member walk, where they used to render as if they were
      // part of whichever package's block happened to print last
      // (AUD-217-10). A rejected pattern is always something lint
      // genuinely could not check: either a literal path the author
      // named specifically (DEC-011's own test), or — since AUD-217-08 —
      // a glob whose parent directory couldn't be scanned, which is not
      // the same as a glob that legitimately matched nothing. Name it,
      // don't drop it (AUD-217-02): the alternative — routing rejected
      // patterns back through lintPackage — would re-join the escaping
      // path and read a Genfile outside the workspace, which is the
      // exact defect CS-32 filed.
      if (rejected.length > 0) {
        console.log(`\n\x1b[1mWorkspace: ${basename(shape.workspaceRoot)}\x1b[0m (${shape.workspaceRoot})\n`);
        for (const { pattern, reason } of rejected) {
          fail(`members entry ${JSON.stringify(pattern)} — ${reason}; not linted`);
        }
      }
      for (const pkgDir of accepted) {
        lintPackage(pkgDir);
      }
      // A literal `members` entry names a path the author declared
      // specifically; if it isn't a package, that's a reportable defect
      // (DEC-011) — lintPackage's own Genfile check produces the loud
      // fail. A glob sweeping over a non-package directory is not: it
      // legitimately picks up non-package siblings, so those stay silent.
      for (const { dir, fromGlob } of missingGenfile) {
        if (!fromGlob) lintPackage(dir);
      }
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
