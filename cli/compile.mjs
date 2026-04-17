#!/usr/bin/env node
/**
 * `cambium compile` (RED-244): factor IR emission out of `cambium run`.
 *
 * Engine-mode hosts wire this into their build (e.g. `npm run prebuild`)
 * to produce `<gen>.ir.json` once at build time. The runtime then loads
 * the IR via `import irData from './<gen>.ir.json'` inside the typed
 * wrapper that `cambium new engine` emits.
 *
 * Same Ruby pipeline as `cambium run` — we only differ in what we do
 * with stdout (write to a file instead of piping into the TS runner).
 * --arg is optional; the Ruby compiler defaults to an empty string when
 * omitted, since the runtime caller is expected to inject real input
 * via the wrapper.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

function bail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

export async function runCompile(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.error(`
Usage:
  cambium compile <file.cmb.rb> --method <method> [--arg <path>|-] [-o <output>]

Compiles a GenModel to IR JSON. No execution. Writes to <output> (or to
<basename>.ir.json next to the input when -o is omitted).
`);
    process.exit(0);
  }

  const file = args[0];
  if (!file || file.startsWith('-')) bail('Missing .cmb.rb file');

  let method = null;
  let arg = null;
  let outputPath = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--method') method = args[++i];
    else if (a === '--arg') arg = args[++i];
    else if (a === '-o') outputPath = args[++i];
    else bail(`Unknown flag: ${a}`);
  }
  if (!method) bail('Missing --method');

  // Default output path: alongside the input as <basename>.ir.json.
  if (!outputPath) {
    const dir = dirname(file);
    const base = basename(file, '.cmb.rb');
    outputPath = join(dir, `${base}.ir.json`);
  }

  // Build the Ruby compile invocation. --arg is optional; we omit it
  // from the spawn args entirely when the user didn't pass one, so the
  // Ruby side falls into its empty-string default.
  const rubyArgs = ['./ruby/cambium/compile.rb', file, '--method', method];
  if (arg !== null) rubyArgs.push('--arg', arg);

  const compile = spawnSync('ruby', rubyArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (compile.status !== 0) {
    console.error(compile.stdout || '');
    console.error(compile.stderr || '');
    process.exit(compile.status ?? 1);
  }

  writeFileSync(outputPath, compile.stdout);
  console.error(`Wrote IR to ${outputPath}`);
}
