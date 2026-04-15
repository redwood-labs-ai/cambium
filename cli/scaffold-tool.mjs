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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const PKG = 'packages/cambium';
const GEN_PATH = `${PKG}/app/gens/tool_scaffold.cmb.rb`;

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
      ['./ruby/cambium/compile.rb', GEN_PATH, '--method', 'scaffold', '--arg', argFile],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    if (compile.status !== 0) {
      console.error(compile.stdout || '');
      console.error(compile.stderr || '');
      bail('Scaffolder compile failed.', compile.status ?? 1);
    }

    // Run
    const run = spawnSync(
      'node',
      ['--import', 'tsx', './src/runner.ts', '--ir', '-', '--out', outFile],
      {
        input: compile.stdout,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    if (run.status !== 0) {
      bail('Scaffolder run failed.', run.status ?? 1);
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
