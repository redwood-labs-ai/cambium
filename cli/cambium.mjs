#!/usr/bin/env node
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { runGenerate } from './generate.mjs';
import { runLint } from './lint.mjs';
import { runInit } from './init.mjs';
import { runDoctor } from './doctor.mjs';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Cambium — Rails for generation engineering

Usage:
  cambium init [name]
  cambium new <type> <Name>
  cambium run <file.cmb.rb> --method <method> --arg <path>|- [--trace <path>] [--out <path>] [--mock] [--memory-key <name>=<value> ...]
  cambium doctor
  cambium test
  cambium lint

Commands:
  init      Initialize a new Cambium workspace
  new       Scaffold a new agent, tool, schema, system, or corrector
  run       Compile and execute a GenModel
  doctor    Check environment setup and dependencies
  test      Run the test suite
  lint      Validate package structure and declarations

Run flags:
  --trace <path>            Write trace JSON to <path> (default: runs/<id>/trace.json)
  --out <path>              Write output JSON to <path> (default: runs/<id>/output.json)
  --mock                    Use deterministic mock instead of live LLM
  --memory-key <name>=<val> Value for a keyed_by slot declared by a memory/pool (repeatable).
                            :session scope auto-generates a session id and echoes it to stderr
                            unless CAMBIUM_SESSION_ID is set.

Examples:
  cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg document.txt
  cambium run gen.cmb.rb --method summarize --arg data.json --trace trace.json --out result.json
  cambium new agent BtcAnalyst
  cambium new tool price_fetcher
  cambium new schema TradeSignal
  cambium doctor
  cambium test
`);
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

// ── cambium new ───────────────────────────────────────────────────────
if (cmd === 'new') {
  // `cambium new tool --describe "..."` routes to the agentic scaffolder.
  // Everything else stays deterministic via runGenerate.
  const describeIdx = args.indexOf('--describe');
  if (describeIdx >= 0 && args[0] === 'tool') {
    const description = args[describeIdx + 1];
    if (!description) {
      console.error('Usage: cambium new tool --describe "<what the tool does>"');
      process.exit(2);
    }
    const { runAgenticToolScaffold } = await import('./scaffold-tool.mjs');
    await runAgenticToolScaffold(description);
    process.exit(0);
  }

  const [type, name] = args;
  runGenerate(type, name);
  process.exit(0);
}

// ── cambium init ──────────────────────────────────────────────────────
if (cmd === 'init') {
  runInit(args[0]);
  process.exit(0);
}

// ── cambium lint ──────────────────────────────────────────────────────
if (cmd === 'lint') {
  runLint();
  process.exit(0);
}

// ── cambium doctor ──────────────────────────────────────────────────
if (cmd === 'doctor') {
  runDoctor();
  // runDoctor calls process.exit internally
}

// ── cambium test ──────────────────────────────────────────────────────
if (cmd === 'test') {
  const result = spawnSync('npx', ['vitest', 'run', ...args], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  process.exit(result.status ?? 1);
}

// ── cambium run ───────────────────────────────────────────────────────
if (cmd !== 'run') usage(`Unknown command: ${cmd}`);

// Handle --help for run
if (args.includes('--help') || args.includes('-h')) usage();

const file = args[0];
if (!file || file.startsWith('-')) usage('Missing .cmb.rb file');

let method = null;
let arg = null;
let traceOut = null;
let outputOut = null;
let mock = false;
const memoryKeys = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method') method = args[++i];
  else if (a === '--arg') arg = args[++i];
  else if (a === '--trace') traceOut = args[++i];
  else if (a === '--out') outputOut = args[++i];
  else if (a === '--mock') mock = true;
  else if (a === '--memory-key') memoryKeys.push(args[++i]);
  else if (a === '--help' || a === '-h') usage();
  else usage(`Unknown flag: ${a}\nRun 'cambium run --help' for usage.`);
}
if (!method) usage('Missing --method\nRun "cambium run --help" for usage.');
if (!arg) usage('Missing --arg\nRun "cambium run --help" for usage.');

// Compile with Ruby → IR JSON (stdout)
const compileEnv = { ...process.env };
if (mock) compileEnv.CAMBIUM_ALLOW_MOCK = '1';
const compile = spawnSync('ruby', ['./ruby/cambium/compile.rb', file, '--method', method, '--arg', arg], {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024
});
if (compile.status !== 0) {
  console.error(compile.stdout || '');
  console.error(compile.stderr || '');
  process.exit(compile.status ?? 1);
}
const irJson = compile.stdout;

// Run IR with TS runner
const runnerArgs = ['--import', 'tsx', './src/runner.ts', '--ir', '-'];
if (traceOut) runnerArgs.push('--trace', traceOut);
if (outputOut) runnerArgs.push('--out', outputOut);
if (mock) runnerArgs.push('--mock');
for (const k of memoryKeys) runnerArgs.push('--memory-key', k);
const run = spawnSync('node', runnerArgs, {
  input: irJson,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
  env: compileEnv,
});
if (run.status !== 0) {
  console.error(run.stdout || '');
  console.error(run.stderr || '');
  process.exit(run.status ?? 1);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
