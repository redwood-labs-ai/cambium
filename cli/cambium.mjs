#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { runGenerate } from './generate.mjs';
import { runLint } from './lint.mjs';
import { runInit } from './init.mjs';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Cambium — Rails for generation engineering

Usage:
  cambium init [name]
  cambium new <type> <Name>
  cambium run <file.cmb.rb> --method <method> --arg <path>|-
  cambium test
  cambium lint

Commands:
  init      Initialize a new Cambium workspace
  new       Scaffold a new agent, tool, schema, system, or corrector
  run       Compile and execute a GenModel
  test      Run the test suite
  lint      Validate package structure and declarations

Examples:
  cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg document.txt
  cambium new agent BtcAnalyst
  cambium new tool price_fetcher
  cambium new schema TradeSignal
  cambium test
`);
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

// ── cambium new ───────────────────────────────────────────────────────
if (cmd === 'new') {
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

const file = args[0];
if (!file) usage('Missing .cmb.rb file');

let method = null;
let arg = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method') method = args[++i];
  else if (a === '--arg') arg = args[++i];
  else usage(`Unknown arg: ${a}`);
}
if (!method) usage('Missing --method');
if (!arg) usage('Missing --arg');

// Compile with Ruby → IR JSON (stdout)
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
const run = spawnSync('node', ['--import', 'tsx', './src/runner.ts', '--ir', '-'], {
  input: irJson,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024
});
if (run.status !== 0) {
  console.error(run.stdout || '');
  console.error(run.stderr || '');
  process.exit(run.status ?? 1);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
