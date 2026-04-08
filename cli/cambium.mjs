#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`\nUsage:\n  cambium run <file.cmb.rb> --method <method> --arg <path>|-\n\nExamples:\n  cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/incident.txt\n`);
  process.exit(2);
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd) usage();
if (cmd !== 'run') usage(`Unknown command: ${cmd}`);
if (!file) usage('Missing .cmb.rb file');

let method = null;
let arg = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--method') method = rest[++i];
  else if (a === '--arg') arg = rest[++i];
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
