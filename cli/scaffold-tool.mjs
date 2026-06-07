#!/usr/bin/env node
/**
 * Agentic tool scaffolder (RED-216).
 *
 * `cambium new tool --describe "..."` routes here. We compile + run
 * ToolScaffold, parse the typed result, show the user what we'd write,
 * and write on confirm.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { detectWorkspaceShape } from './workspace-shape.mjs';

// Framework files resolved relative to the CLI's own location, not cwd
// (RED-274 — mirrors cambium.mjs and compile.mjs). The scaffolder gen,
// Ruby compile script, and TS runner are all shipped with the framework.
// The output destination (where the scaffolder writes the generated tool
// files) is resolved at call time via detectWorkspaceShape (RED-286) so
// both monorepo workspace and flat [package] layouts land correctly.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(CLI_DIR, '..');
const RUBY_COMPILE_SCRIPT = resolve(FRAMEWORK_ROOT, 'ruby', 'cambium', 'compile.rb');
const GEN_PATH = resolve(FRAMEWORK_ROOT, 'packages', 'cambium', 'app', 'gens', 'tool_scaffold.cmb.rb');

function bail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function confirm(prompt) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${prompt} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runAgenticToolScaffold(description) {
  if (!existsSync(GEN_PATH)) {
    bail(`Tool scaffold gen not found at ${GEN_PATH}. Is this a Cambium workspace with the scaffolder installed?`);
  }

  // Resolve the app-package root from cwd (RED-286). For the cambium
  // monorepo this is <root>/packages/cambium; for a flat external app
  // it is <root> itself.
  const shape = detectWorkspaceShape(process.cwd());
  if (!shape) {
    bail(
      'No Cambium workspace detected at cwd or ancestors.\n' +
      'Run from inside a project with Genfile.toml (workspace or package) or a packages/cambium/ subdir.',
    );
  }
  const PKG = shape.appPkgRoot;

  console.log(`\nScaffolding tool from description:`);
  console.log(`  "${description}"\n`);
  console.log(`Running ToolScaffold agent...`);

  // The gen takes the description via --arg (context document).
  const argFile = join(tmpdir(), `cambium-scaffold-${Date.now()}.txt`);
  writeFileSync(argFile, description);

  const outFile = join(tmpdir(), `cambium-scaffold-out-${Date.now()}.json`);

  try {
    // Compile
    const compile = spawnSync(
      'ruby',
      [RUBY_COMPILE_SCRIPT, GEN_PATH, '--method', 'scaffold', '--arg', argFile],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    if (compile.status !== 0) {
      console.error(compile.stdout || '');
      console.error(compile.stderr || '');
      bail('Scaffolder compile failed.', compile.status ?? 1);
    }

    // RED-306: run in-process via @redwood-labs/cambium-runner (replaces the prior
    // `node --import tsx .../runner.ts` subprocess).
    let ir;
    try {
      ir = JSON.parse(compile.stdout);
    } catch (err) {
      bail(`Failed to parse IR JSON from ruby compile: ${err?.message || err}`);
    }
    let runResult;
    try {
      const { runGenFromIr } = await import('@redwood-labs/cambium-runner');
      runResult = await runGenFromIr({
        ir,
        cwd: process.cwd(),
        outputOut: outFile,
      });
    } catch (err) {
      console.error(err?.stack || String(err));
      bail('Scaffolder run failed.');
    }
    if (!runResult.ok) {
      bail(`Scaffolder run failed${runResult.errorMessage ? `: ${runResult.errorMessage}` : ''}`);
    }

    if (!existsSync(outFile)) {
      bail(`Scaffolder produced no output at ${outFile}.`);
    }

    const result = JSON.parse(readFileSync(outFile, 'utf8'));

    // Validate minimum shape — the AJV step in the runner should have
    // caught schema violations, but belt-and-suspenders.
    for (const k of ['name', 'description', 'permissions', 'input_schema', 'output_schema', 'handler_typescript', 'rationale']) {
      if (!(k in result)) bail(`Scaffolder output missing required field: ${k}`);
    }

    const snake = result.name;
    if (!/^[a-z][a-z0-9_]*$/.test(snake)) {
      bail(`Scaffolder produced an invalid tool name: "${snake}". Must match /^[a-z][a-z0-9_]*$/.`);
    }

    const jsonPath = join(PKG, 'app/tools', `${snake}.tool.json`);
    const tsPath = join(PKG, 'app/tools', `${snake}.tool.ts`);

    // Assemble the .tool.json body.
    const toolJson = {
      name: snake,
      description: result.description,
      permissions: result.permissions,
      inputSchema: result.input_schema,
      outputSchema: result.output_schema,
    };

    // Preview
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Proposed tool: ${snake}`);
    console.log('─'.repeat(60));
    console.log(`\nRationale:\n  ${result.rationale}\n`);
    console.log(`Would write ${jsonPath}:\n`);
    console.log(JSON.stringify(toolJson, null, 2));
    console.log(`\nWould write ${tsPath}:\n`);
    console.log(result.handler_typescript);
    console.log(`\n${'─'.repeat(60)}`);

    // Red-flag scan (AUD-006): check the generated handler for patterns that
    // conflict with its declared permissions. A prompt-injected scaffolder
    // could emit `permissions: { pure: true }` with a body that does execs.
    // This scan runs BEFORE the y/N confirm so the user sees flags in the
    // preview area, not silently after they've already said yes.
    const handlerTs = result.handler_typescript;
    const redFlags = [];
    const DANGEROUS_PATTERNS = [
      { re: /\bchild_process\b/, label: 'child_process import (exec capability)' },
      { re: /\bspawnSync\b|\bspawn\b|\bexecSync\b|\bexec\b/, label: 'process-spawn call' },
      { re: /\beval\s*\(/, label: 'eval() call' },
      { re: /\bnew\s+Function\s*\(/, label: 'new Function() call' },
      { re: /\brequire\s*\(\s*[^'"`]/, label: 'dynamic require() with non-literal argument' },
    ];
    for (const { re, label } of DANGEROUS_PATTERNS) {
      if (re.test(handlerTs)) redFlags.push(`  ⚠  ${label}`);
    }
    // Permission-vs-body cross-check: if permissions claim 'pure' or omit
    // network/exec/filesystem, flag any body patterns that would need those capabilities.
    const perms = result.permissions ?? {};
    if (!perms.network && /\bfetch\b|\bctx\.fetch\b|\bhttp\b/.test(handlerTs)) {
      redFlags.push('  ⚠  body uses fetch/http but permissions.network is not declared');
    }
    if (!perms.exec && /\bexecute_code\b|\bchild_process\b|\bspawn/.test(handlerTs)) {
      redFlags.push('  ⚠  body uses exec patterns but permissions.exec is not declared');
    }
    if (!perms.filesystem && /readFile|writeFile|import ['"](?:node:)?fs|createReadStream|createWriteStream/.test(handlerTs)) {
      redFlags.push('  ⚠  body uses filesystem patterns but permissions.filesystem is not declared');
    }
    if (redFlags.length > 0) {
      console.log(`\n⚠  Red-flag scan found ${redFlags.length} concern(s) in the generated handler:\n`);
      for (const f of redFlags) console.log(f);
      console.log('\nReview the handler carefully before writing.\n');
    }

    // Existence check
    if (existsSync(jsonPath) || existsSync(tsPath)) {
      const existing = [jsonPath, tsPath].filter(p => existsSync(p));
      bail(`Refusing to overwrite existing files:\n  ${existing.join('\n  ')}\nRename the tool or delete the existing files first.`);
    }

    const ok = await confirm('Write these files?');
    if (!ok) {
      console.log('Aborted. No files written.');
      return;
    }

    mkdirSync(join(PKG, 'app/tools'), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(toolJson, null, 2) + '\n');
    writeFileSync(tsPath, result.handler_typescript.endsWith('\n') ? result.handler_typescript : result.handler_typescript + '\n');

    console.log(`\n✓ Wrote ${jsonPath}`);
    console.log(`✓ Wrote ${tsPath}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Review the handler — the scaffolder leaves TODOs where logic needs filling in.`);
    console.log(`  2. Run \`cambium lint\` to verify the tool integrates with your gens.`);
    console.log(`  3. Declare in your agent: uses :${snake}`);
  } finally {
    try { unlinkSync(argFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }
}
