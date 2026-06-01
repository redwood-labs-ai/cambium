#!/usr/bin/env node
// RED-306: register the tsx ESM loader hook at CLI startup so user
// schemas (contracts.ts, engine-mode schemas.ts) load under plain
// `node`. The prior subprocess architecture used `node --import tsx`
// to get this hook; Option B (in-process runGenFromIr) needs the
// equivalent registered programmatically on the one process we run.
// `tsx/esm/api`'s `register()` returns an unregister callback we do
// not currently call — the hook stays live for the duration of the
// CLI invocation, which is what we want.
import { register } from 'tsx/esm/api';
register();

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
import { readExplicitStdinArg } from './stdin-arg.mjs';
import { runGenerate } from './generate.mjs';
import { runLint } from './lint.mjs';
import { runInit } from './init.mjs';
import { runDoctor } from './doctor.mjs';

// Framework files resolved relative to the CLI's own location, not cwd.
// External apps (app-mode, cf. RED-220 / RED-274) run `cambium run` from
// their own project directory — a cwd-relative `./ruby/...` is nowhere
// on their filesystem. `compile.mjs` already took this stance; this
// mirrors it. (RED-274)
//
// RED-306: the TS runner is no longer invoked as a subprocess. The CLI
// imports `runGenFromIr` from `@redwood-labs/cambium-runner` and invokes it
// in-process (Option B).
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUBY_COMPILE_SCRIPT = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Cambium — Rails for generation engineering

Usage:
  cambium init [name]
  cambium new <type> <Name>
  cambium run <file.cmb.rb> --method <method> [--arg <path>|-] [--trace <path>] [--out <path>] [--mock] [--memory-key <name>=<value> ...] [--session-id <id>] [--profile <name>]
  cambium compile <file.cmb.rb> [--method <method>] [--arg <path>|-] [-o <output>]
  cambium compile [--out-dir <dir>] [--write]   # (no file) recompile every gen/pipeline IR in the workspace
  cambium serve --workspace <path> --bind <uri> [--allow-remote]
  cambium inspect [run-id] [--port <n>] [--runs-dir <path>] [--host <h>] [--allow-remote] [--no-open]
  cambium doctor
  cambium test
  cambium lint

Commands:
  init      Initialize a new Cambium workspace
  new       Scaffold a new engine, agent, tool, action, schema, system, corrector, policy, memory_pool, or config
  run       Compile and execute a GenModel
  replay    Re-run a prior run's post-Generate tail from its candidate output,
            skipping the expensive Generate. --edit / --from-step <type>.
  compile   Compile a GenModel to IR JSON (no execution; engine-mode build step).
            Without --method, emits a {method → IR} map for every public method.
            With NO file, recompiles every gen/pipeline in the workspace:
            engine mode writes each <base>.ir.json; app mode validates only
            (--out-dir/--write to materialize). (RED-407)
  serve     Start a long-lived HTTP server hosting every gen in this workspace.
  inspect   Start a local read-only trace viewer over this workspace's runs/.
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
  --profile <name>          Pick the active profile from app/config/models.rb (RED-326).
                            Must match /^[a-z][a-z0-9_]*$/. Wins over CAMBIUM_PROFILE.

Compile flags:
  -o <path>                 Write IR JSON to <path> (default: <basename>.ir.json next to the input)
  --arg <path>|-            Optional fixture path. When omitted, an empty string is supplied
                            to the gen method — the runtime caller injects real input later.

Compile-all flags (no file argument):
  --out-dir <dir>           Write all IRs into <dir> (created if needed). Implies --write.
  --write                   Materialize IRs next to each source even in app mode.

Examples:
  cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg document.txt
  cambium run gen.cmb.rb --method summarize --arg data.json --trace trace.json --out result.json
  cambium replay run_20260422_114135_abc --edit
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
  const mod = await import('./compile.mjs');
  // No positional file → compile-all (recompile every gen/pipeline IR in the
  // workspace, mode-aware: engine writes IRs, app validates). A leading flag
  // (e.g. --out-dir, --help) also routes to compile-all. (RED-407)
  const hasFile = args[0] && !args[0].startsWith('-');
  if (hasFile) await mod.runCompile(args);
  else await mod.runCompileAll(args);
  process.exit(0);
}

// ── cambium schedule (RED-305) ──────────────────────────────────────
if (cmd === 'schedule') {
  const { runSchedule } = await import('./schedule.mjs');
  await runSchedule(args);
  process.exit(0);
}

// ── cambium serve (RED-360) ────────────────────────────────────────
if (cmd === 'serve') {
  const { runServeCli } = await import('./serve.mjs');
  await runServeCli(args);
  // runServeCli runs until a signal arrives; if it returns, exit cleanly.
  process.exit(0);
}

// ── cambium inspect (RED-313) ───────────────────────────────────────
if (cmd === 'inspect') {
  const { runInspectCli } = await import('./inspect.mjs');
  await runInspectCli(args);
  // runInspectCli blocks until a signal arrives; if it returns, exit cleanly.
  process.exit(0);
}

// ── cambium replay (RED-312) ────────────────────────────────────────
if (cmd === 'replay') {
  const { runReplay } = await import('./replay.mjs');
  await runReplay(args);
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
let profile = null;
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
  else if (a === '--profile') profile = args[++i];
  else if (a === '--help' || a === '-h') usage();
  else usage(`Unknown flag: ${a}\nRun 'cambium run --help' for usage.`);
}
if (!method) usage('Missing --method\nRun "cambium run --help" for usage.');
// --arg is optional (RED-244, RED-bug). When omitted, pass an empty JSON
// object via stdin — works for both pipelines (which expect an object
// matching their input schema) and gens with all-optional inputs.
// Documented behavior on line 82; the previous "Missing --arg" block
// contradicted the docs.
// RED-397: distinguish an OMITTED --arg (default to an empty JSON object
// fed via stdin) from an EXPLICIT `--arg -` (forward the real piped stdin).
// `argFromStdin = !arg` is true only when omitted; capture the explicit
// dash BEFORE the default reassignment below.
const explicitStdin = arg === '-';
const argFromStdin = !arg;
if (argFromStdin) arg = '-';

// RED-326: validate --profile against the same regex Ruby's
// ModelAliases::NAME_RE enforces. Failing here is nicer than failing
// inside the Ruby subprocess.
if (profile !== null) {
  if (!/^[a-z][a-z0-9_]*$/.test(profile)) {
    console.error(
      `Invalid --profile "${profile}". Must match /^[a-z][a-z0-9_]*$/ ` +
        `(lowercase snake_case).`,
    );
    process.exit(2);
  }
}

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

// Compile with Ruby → IR JSON (stdout). Ruby stays a subprocess — the
// compiler is Ruby and reading a Ruby process's stdout is the right
// cross-runtime boundary.
const compileEnv = { ...process.env };
if (mock) compileEnv.CAMBIUM_ALLOW_MOCK = '1';
// --session-id wins over an inherited CAMBIUM_SESSION_ID so the flag is
// the source of truth when the user is explicit. (RED-284)
if (sessionId !== null) compileEnv.CAMBIUM_SESSION_ID = sessionId;
// RED-326: --profile wins over an inherited CAMBIUM_PROFILE — the flag
// is the explicit override. The Ruby ModelAliases.load reads
// CAMBIUM_PROFILE to pick the active profile.
if (profile !== null) compileEnv.CAMBIUM_PROFILE = profile;
// Resolve what to feed the Ruby child's stdin:
//   - omitted --arg      → '{}' (empty JSON object; valid when every input
//                          field is optional, and the shape pipelines expect)
//   - explicit `--arg -` → the parent's real piped stdin (RED-397)
//   - `--arg <file>`     → undefined; compile.rb reads the file itself
let compileInput;
if (argFromStdin) {
  compileInput = '{}';
} else if (explicitStdin) {
  try {
    compileInput = readExplicitStdinArg('cambium run');
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(2);
  }
} else {
  compileInput = undefined;
}
const compile = spawnSync('ruby', [RUBY_COMPILE_SCRIPT, file, '--method', method, '--arg', arg], {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
  env: compileEnv,
  input: compileInput,
});
if (compile.status !== 0) {
  console.error(compile.stdout || '');
  console.error(compile.stderr || '');
  process.exit(compile.status ?? 1);
}

// RED-306: run the IR in-process via `@redwood-labs/cambium-runner`. Replaces the
// prior `node --import tsx packages/cambium-runner/src/runner.ts`
// subprocess. Benefits: no `tsx` runtime dep for end users, no
// subprocess-boundary env-race for CAMBIUM_ALLOW_MOCK, faster startup.
let ir;
try {
  ir = JSON.parse(compile.stdout);
} catch (err) {
  console.error(`Failed to parse IR JSON from ruby compile stdout: ${err?.message || err}`);
  console.error(compile.stdout);
  process.exit(1);
}

// Apply --session-id / --mock via env vars for any runGen-internal code
// that reads them (matches the pre-RED-306 subprocess env). runGenFromIr
// also restores CAMBIUM_ALLOW_MOCK on return.
const previousMockEnv = process.env.CAMBIUM_ALLOW_MOCK;
const previousSessionEnv = process.env.CAMBIUM_SESSION_ID;
if (mock) process.env.CAMBIUM_ALLOW_MOCK = '1';
if (sessionId !== null) process.env.CAMBIUM_SESSION_ID = sessionId;

try {
  // RED-381 Phase B: Pipeline IRs dispatch through a separate entry
  // point. Detect by the top-level `kind: "Pipeline"` field that
  // `pipeline.rb`'s PipelineCompiler emits; gen IRs don't carry a kind.
  // Falls through to runGenFromIr for all gen IRs unchanged.
  const isPipeline = ir?.kind === 'Pipeline';
  const runner = await import('@redwood-labs/cambium-runner');
  const result = isPipeline
    ? await runner.runPipelineFromIr({
        ir,
        cwd: process.cwd(),
        traceOut,
        outputOut,
        mock,
        firedBy: firedBy ?? undefined,
        // Pass compile.rb path explicitly so the per-step sub-gen
        // compile inside runPipelineFromIr doesn't depend on cwd
        // (which breaks running pipelines from external `[package]`
        // workspaces; the runner package doesn't ship ruby/).
        compileRb: RUBY_COMPILE_SCRIPT,
      })
    : await runner.runGenFromIr({
        ir,
        cwd: process.cwd(),
        traceOut,
        outputOut,
        mock,
        memoryKeys,
        sessionId: sessionId ?? undefined,
        firedBy: firedBy ?? undefined,
      });

  if (!result.ok) {
    if (result.errorMessage) {
      console.error(`${result.errorMessage}. See ${result.tracePath}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify(result.output, null, 2));
  console.error(`Trace: ${result.tracePath}`);
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
} finally {
  if (mock) {
    if (previousMockEnv === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = previousMockEnv;
  }
  if (sessionId !== null) {
    if (previousSessionEnv === undefined) delete process.env.CAMBIUM_SESSION_ID;
    else process.env.CAMBIUM_SESSION_ID = previousSessionEnv;
  }
}
