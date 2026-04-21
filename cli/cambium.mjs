#!/usr/bin/env node
// RED-295: load .env files before any CLI subcommand dispatch. Safe at
// this placement because none of the below imports read process.env at
// module-top-level — every access is inside a function body that runs
// only after command dispatch. If that ever changes, promote this to a
// side-effect import module so the load happens before any transitive
// module evaluation.
import { loadEnvFiles } from './env-discovery.mjs';
loadEnvFiles();
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { runGenerate } from './generate.mjs';
import { runLint } from './lint.mjs';
import { runInit } from './init.mjs';
import { runDoctor } from './doctor.mjs';

// Framework files resolved relative to the CLI's own location, not cwd.
// External apps (app-mode, cf. RED-220 / RED-274) run `cambium run` from
// their own project directory — a cwd-relative `./ruby/...` or
// `./packages/...` is nowhere on their filesystem. `compile.mjs` already
// took this stance; this mirrors it. (RED-274)
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUBY_COMPILE_SCRIPT = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');
const RUNNER_SCRIPT = resolve(CLI_DIR, '..', 'packages', 'cambium-runner', 'src', 'runner.ts');

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Cambium — Rails for generation engineering

Usage:
  cambium init [name]
  cambium new <type> <Name>
  cambium run <file.cmb.rb> --method <method> --arg <path>|- [--trace <path>] [--out <path>] [--mock] [--memory-key <name>=<value> ...] [--session-id <id>]
  cambium compile <file.cmb.rb> --method <method> [--arg <path>|-] [-o <output>]
  cambium doctor
  cambium test
  cambium lint

Commands:
  init      Initialize a new Cambium workspace
  new       Scaffold a new engine, agent, tool, action, schema, system, corrector, policy, memory_pool, or config
  run       Compile and execute a GenModel
  compile   Compile a GenModel to IR JSON (no execution; engine-mode build step)
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
  --session-id <id>         Explicit session id for memory :session scope. Must match
                            /^[a-zA-Z0-9_\-]+$/ and be 1-128 chars. Wins over CAMBIUM_SESSION_ID.

Compile flags:
  -o <path>                 Write IR JSON to <path> (default: <basename>.ir.json next to the input)
  --arg <path>|-            Optional fixture path. When omitted, an empty string is supplied
                            to the gen method — the runtime caller injects real input later.

Examples:
  cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg document.txt
  cambium run gen.cmb.rb --method summarize --arg data.json --trace trace.json --out result.json
  cambium compile cambium/summarizer/summarizer.cmb.rb --method analyze
  cambium new engine Summarizer
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

// ── cambium compile ──────────────────────────────────────────────────
if (cmd === 'compile') {
  const { runCompile } = await import('./compile.mjs');
  await runCompile(args);
  process.exit(0);
}

// ── cambium schedule (RED-305) ──────────────────────────────────────
if (cmd === 'schedule') {
  const { runSchedule } = await import('./schedule.mjs');
  await runSchedule(args);
  process.exit(0);
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
let sessionId = null;
const memoryKeys = [];
let firedBy = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method') method = args[++i];
  else if (a === '--arg') arg = args[++i];
  else if (a === '--trace') traceOut = args[++i];
  else if (a === '--out') outputOut = args[++i];
  else if (a === '--mock') mock = true;
  else if (a === '--memory-key') memoryKeys.push(args[++i]);
  else if (a === '--session-id') sessionId = args[++i];
  else if (a === '--fired-by') firedBy = args[++i];
  else if (a === '--help' || a === '-h') usage();
  else usage(`Unknown flag: ${a}\nRun 'cambium run --help' for usage.`);
}
if (!method) usage('Missing --method\nRun "cambium run --help" for usage.');
if (!arg) usage('Missing --arg\nRun "cambium run --help" for usage.');

// RED-284: validate --session-id against the same regex the runner
// enforces on CAMBIUM_SESSION_ID (keys.ts#validateSafeSegment). Failing
// here is nicer than failing inside the subprocess.
if (sessionId !== null) {
  if (sessionId.length === 0 || sessionId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(sessionId)) {
    console.error(
      `Invalid --session-id "${sessionId}". Must match /^[a-zA-Z0-9_\\-]+$/ and be 1-128 chars.`,
    );
    process.exit(2);
  }
}

// RED-289: engine-mode stale-IR hint. `cambium run` recompiles on
// every call, so the committed `<name>.ir.json` is NOT updated. Host
// code that imports the typed wrapper picks up whatever IR is on
// disk — stale if nobody ran `cambium compile` after editing the gen.
// Fire a one-liner stderr note when the sibling IR is older than the
// gen source; silent otherwise.
{
  const genDir = dirname(resolve(file));
  if (existsSync(join(genDir, 'cambium.engine.json'))) {
    const base = basename(file, '.cmb.rb');
    const irPath = join(genDir, `${base}.ir.json`);
    if (existsSync(irPath)) {
      try {
        const irMtime = statSync(irPath).mtimeMs;
        const srcMtime = statSync(resolve(file)).mtimeMs;
        if (irMtime < srcMtime) {
          console.error(
            `Note: ${base}.ir.json is older than ${base}.cmb.rb. ` +
            `\`cambium run\` recompiles, but the committed IR wasn't refreshed — ` +
            `run \`cambium compile ${file}\` to update it for host imports.`,
          );
        }
      } catch { /* stat failures non-fatal */ }
    }
  }
}

// Compile with Ruby → IR JSON (stdout)
const compileEnv = { ...process.env };
if (mock) compileEnv.CAMBIUM_ALLOW_MOCK = '1';
// --session-id wins over an inherited CAMBIUM_SESSION_ID so the flag is
// the source of truth when the user is explicit. (RED-284)
if (sessionId !== null) compileEnv.CAMBIUM_SESSION_ID = sessionId;
const compile = spawnSync('ruby', [RUBY_COMPILE_SCRIPT, file, '--method', method, '--arg', arg], {
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
const runnerArgs = ['--import', 'tsx', RUNNER_SCRIPT, '--ir', '-'];
if (traceOut) runnerArgs.push('--trace', traceOut);
if (outputOut) runnerArgs.push('--out', outputOut);
if (mock) runnerArgs.push('--mock');
for (const k of memoryKeys) runnerArgs.push('--memory-key', k);
if (firedBy) runnerArgs.push('--fired-by', firedBy);
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
