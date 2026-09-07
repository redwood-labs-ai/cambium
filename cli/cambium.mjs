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
import { existsSync, statSync, readFileSync } from 'node:fs';
import { readExplicitStdinArg } from './stdin-arg.mjs';
import { runGenerate } from './generate.mjs';
import { runLint } from './lint.mjs';
import { runInit } from './init.mjs';
import { runDoctor } from './doctor.mjs';
import { loadRunner } from './runner-freshness.mjs';

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
  cambium run <file.cmb.rb> --method <method> [--arg <path>|-] [--trace <path>] [--out <path>] [--mock] [--memory-key <name>=<value> ...] [--session-id <id>] [--profile <name>] [--fired-by <id>]
  cambium run --ir <file.ir.json> [--method <method>] [--arg <path>|-] [--trace <path>] [--out <path>] [--mock] [--memory-key <name>=<value> ...] [--session-id <id>] [--fired-by <id>]
  cambium replay <run-id|path> [--edit] [--from-step <type>] [--from-op <id>] [--mock]
  cambium compile <file.cmb.rb> [--method <method>] [--arg <path>|-] [-o <output>]
  cambium compile [--out-dir <dir>] [--write]   # (no file) recompile every gen/pipeline IR in the workspace
  cambium serve --workspace <path> --bind <uri> [--allow-remote] [--precompiled|--ir-dir <dir>]
  cambium inspect [run-id] [--port <n>] [--runs-dir <path>] [--host <h>] [--allow-remote] [--no-open]
  cambium schedule preview|list|compile <args>
  cambium doctor
  cambium test
  cambium lint

Commands:
  init      Initialize a new Cambium workspace
  new       Scaffold a new engine, agent, tool, action, schema, system, corrector, policy, memory_pool, config, log_profile, pipeline, or provider
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
  schedule  Manage cron-style scheduled fires (preview, list, compile manifests)

Run flags:
  --arg <path>|-            Optional input. Omitted keeps whatever compile time bakes
                            in for the method (a from: default, RED-383, or an empty
                            string with no bake-in) — the same default cambium compile
                            and cambium run --ir use for an omitted --arg (#220).
                            --arg '' is treated as omitted too (never forwarded to
                            Ruby's File.read); neither cambium run --ir nor cambium
                            compile makes this same allowance for --arg '' (both gate
                            on arg !== null, so both try to read the empty path —
                            cambium compile with a raw Ruby Errno::ENOENT, cambium
                            run --ir with a Cambium-shaped error; see --ir's own
                            --arg note below).
                            A pipeline (not a gen) with one or more declared input
                            slots refuses an omitted --arg instead: exit 2, naming the
                            pipeline, its slots, and how to supply a value (#223) —
                            a slot has no optional: or default:, so omitting it is
                            always a caller mistake, never a value to default.
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
                            Not valid with --ir (profiles resolve at compile time; recompile
                            with --profile instead).
  --fired-by <id>           Label recording why this run was triggered (e.g. a cron job
                            id). Surfaces in trace.json and observability logs.

Run --ir flags (#195): execute a precompiled .ir.json artifact directly — no
Ruby, no positional .cmb.rb. Mutually exclusive with a positional file.
  --ir <file.ir.json>       The artifact to run — a single IR (compile --method) or a
                            {method → IR} map (bare-mode compile). Refused if the IR
                            still needs Ruby at run time (a pipeline, an enrich gen,
                            or a retro memory-write agent — #195 DEC-001).
  --method <method>         Required for a map artifact (error lists the available
                            methods); optional for a single-IR artifact, and must match
                            its own entry.method when given.
  --arg <path>|-            Overrides the artifact's baked-in context. Omitted keeps
                            what compile time baked in (the from: default, RED-383) —
                            same default the compile-then-run path above uses for an
                            omitted --arg (#220). Not parity for every input: --arg ''
                            gates on arg !== null here, so it reads the artifact's own
                            file at the empty path and exits 1, while the compile-then-
                            run path treats --arg '' as omitted too (see its own --arg
                            note above).

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
  cambium run --ir dist/ir/analyst.ir.json --method analyze --arg document.txt --mock
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

// ── cambium run --ir (#195 DEC-006) ─────────────────────────────────────
//
// Executes a precompiled `.ir.json` artifact directly: no Ruby spawn, no
// positional .cmb.rb. Shares the run flags (--mock, --trace, --out,
// --memory-key, --session-id, --fired-by) with the compile-then-run path
// below; --profile is refused outright (profiles resolve at compile
// time, RED-326) and --arg's default differs (keeps the artifact's baked
// context instead of Ruby's empty-string default) — both called out in
// `cambium run --help`.
async function runFromPrecompiledIr(args) {
  let irPath = null;
  let method = null;
  let arg = null;
  let traceOut = null;
  let outputOut = null;
  let mock = false;
  let sessionId = null;
  const memoryKeys = [];
  let firedBy = null;
  let profile = null;
  let positional = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ir') irPath = args[++i];
    else if (a === '--method') method = args[++i];
    else if (a === '--arg') arg = args[++i];
    else if (a === '--trace') traceOut = args[++i];
    else if (a === '--out') outputOut = args[++i];
    else if (a === '--mock') mock = true;
    else if (a === '--memory-key') memoryKeys.push(args[++i]);
    else if (a === '--session-id') sessionId = args[++i];
    else if (a === '--fired-by') firedBy = args[++i];
    else if (a === '--profile') profile = args[++i];
    else if (a === '--help' || a === '-h') usage();
    else if (!a.startsWith('-') && positional === null) positional = a;
    else usage(`Unknown flag: ${a}\nRun 'cambium run --help' for usage.`);
  }

  if (positional !== null) {
    usage(`cambium run: --ir and a positional file ("${positional}") are mutually exclusive.`);
  }
  if (!irPath) usage('Missing --ir <file.ir.json>\nRun "cambium run --help" for usage.');
  if (profile !== null) {
    usage(
      'cambium run --ir: --profile has no effect on a precompiled artifact (profiles resolve ' +
        'at compile time, RED-326). Recompile with --profile (or CAMBIUM_PROFILE) instead.',
    );
  }
  // RED-284: same session-id validation the compile-then-run path applies.
  if (sessionId !== null) {
    if (sessionId.length === 0 || sessionId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(sessionId)) {
      console.error(
        `Invalid --session-id "${sessionId}". Must match /^[a-zA-Z0-9_\\-]+$/ and be 1-128 chars.`,
      );
      process.exit(2);
    }
  }

  const runner = await loadRunner();

  // Size-bounded read + structural validation, one path shared with
  // `cambium serve --precompiled` (ir-artifact.ts#readIrArtifactFile).
  let parsed;
  try {
    parsed = runner.readIrArtifactFile(irPath);
  } catch (err) {
    console.error(`cambium run --ir: ${err?.message ?? String(err)}`);
    process.exit(1);
  }

  let ir;
  if (parsed.kind === 'single') {
    if (method !== null && method !== parsed.ir.entry.method) {
      usage(
        `cambium run --ir: --method "${method}" does not match this artifact's method ` +
          `"${parsed.ir.entry.method}".`,
      );
    }
    ir = parsed.ir;
  } else {
    const methods = Object.keys(parsed.irs).sort();
    if (method === null) {
      usage(
        `cambium run --ir: --method is required for a multi-method artifact. ` +
          `Available: ${methods.join(', ')}`,
      );
    }
    ir = parsed.irs[method];
    if (!ir) {
      // Flag misuse, like a --method that mismatches a single-IR artifact
      // (AUD-003): both are "you named a method this artifact doesn't have".
      usage(`cambium run --ir: artifact has no method "${method}". Available: ${methods.join(', ')}`);
    }
  }

  // #195 DEC-005: anchor discovery on the ARTIFACT's own location, not
  // cwd or the build-machine ir.entry.source — the operator contract for
  // a shipped precompiled IR. Explicit engineDir/appRoot win outright
  // inside runGenFromIr (the RED-353/RED-393 tiers below them untouched).
  const irAbsPath = resolve(irPath);
  let anchors;
  try {
    anchors = runner.resolveArtifactAnchors(irAbsPath);
  } catch (err) {
    // Malformed Genfile / missing declared contracts file in the
    // artifact's workspace (DEV-002 class) — a clean exit 1, not an
    // uncaught rejection.
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
  const { engineDir, appRoot } = anchors;

  // #195 DEC-004: a symbol-form gen needs a contracts module at run time —
  // check it against the workspace this artifact anchors on BEFORE any
  // run dir is created. Engine mode sources its own
  // `<engineDir>/schemas.ts` instead (checked inside runGenFromIr), so
  // `contractsDeclared` is null there and this check is app-mode only.
  if (!engineDir && runner.needsContracts(ir) && !anchors.contractsDeclared) {
    console.error(
      `cambium run --ir: "${ir.entry.class}" uses symbol-form returns (\`returns :Symbol\`) but ` +
        `${appRoot ?? dirname(irAbsPath)} declares no [types].contracts. Ship inline ` +
        `\`returns do … end\` schemas, or declare [types].contracts and ship the contracts file.`,
    );
    process.exit(1);
  }

  // --arg: omitted keeps the artifact's baked-in context (RED-383's
  // `from:` default); explicit --arg overrides it exactly like serve's
  // per-request injection (DEC-003's injectContextInput).
  if (arg !== null) {
    let argText;
    if (arg === '-') {
      try {
        argText = readExplicitStdinArg('cambium run --ir');
      } catch (err) {
        console.error(err?.message ?? String(err));
        process.exit(2);
      }
    } else {
      try {
        argText = readFileSync(arg, 'utf8');
      } catch (err) {
        console.error(`cambium run --ir: failed to read --arg ${arg}: ${err?.message ?? err}`);
        process.exit(1);
      }
    }
    runner.injectContextInput(ir, argText);
  }

  const previousMockEnv = process.env.CAMBIUM_ALLOW_MOCK;
  const previousSessionEnv = process.env.CAMBIUM_SESSION_ID;
  if (mock) process.env.CAMBIUM_ALLOW_MOCK = '1';
  if (sessionId !== null) process.env.CAMBIUM_SESSION_ID = sessionId;

  try {
    const result = await runner.runGenFromIr({
      ir,
      cwd: process.cwd(),
      traceOut,
      outputOut,
      mock,
      memoryKeys,
      sessionId: sessionId ?? undefined,
      firedBy: firedBy ?? undefined,
      ...(engineDir ? { engineDir } : {}),
      ...(appRoot ? { appRoot } : {}),
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
}

// ── cambium run ───────────────────────────────────────────────────────
if (cmd !== 'run') usage(`Unknown command: ${cmd}`);

// Handle --help for run
if (args.includes('--help') || args.includes('-h')) usage();

// #195 DEC-006: `--ir <artifact>` executes a precompiled IR directly —
// no Ruby spawn, no positional .cmb.rb. Checked before the positional
// parsing below so `--ir`'s own value can't be mistaken for the gen file.
if (args.includes('--ir')) {
  await runFromPrecompiledIr(args);
  process.exit(0);
}

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
// --arg is optional (RED-244, RED-bug). An omitted --arg is forwarded to
// Ruby as an omission — no --arg flag at all — so compile.rb (the
// authority on gen-vs-pipeline, since it dispatches on the class
// registry after `load file`) applies the right default for a gen: a
// `from:` bake-in applies, or the method receives ''. The CLI never
// guesses from the filename.
//
// A pipeline's own "nothing supplied" case is NOT a default anymore
// (#223 DEC-001) — a declared `input` slot is mandatory by construction
// (there is no `optional:`/`default:` on `input`), so an omitted --arg
// against a pipeline with >=1 slot is a caller error, refused below once
// the compiled IR's own `kind` says this is a Pipeline (see the
// `isPipeline` gate near the dispatch call — note that's a different
// gate than #195's above, same label, different plan). The refusal
// lives here and nowhere else: two earlier designs tried elsewhere and
// leaked — inside compile.rb (#220 DEC-002) into the golden corpus and
// `cambium serve` boot cataloging, because compile.rb can't tell this
// CLI call from a bare `ruby compile.rb` invocation; inside
// `parsePipelineInputs` (#220 DEC-005) into `cambium serve` dispatch,
// `cambium replay`, and library callers of `runPipelineFromIr`, because
// none of them go through this CLI either — an audit
// (records/AUDIT-220-round1-2026-09-03.md, AUD-001) caught it end to
// end. The CLI is the only layer that saw the argv and can tell "the
// caller supplied nothing" from "the caller supplied emptiness"; both
// `parsePipelineInputs` and `compile.rb` end this change untouched too
// (#223 DEC-002). (#220 had forged `--arg -` + stdin `'{}'` for every
// omission, clobbering `from:` bake-ins on the gen path; #223 removes
// the pipeline-side substitute that replaced it, `'{}'` in the recorded
// `context._pipeline_arg`, since a literal `{}` reaching a model as its
// document was the same bug in a different shape — see
// records/PLAN-223-pipeline-arg-default-2026-09-04.md.)
// RED-397: distinguish an OMITTED --arg (forwarded as an omission) from
// an EXPLICIT `--arg -` (forward the real piped stdin). `argOmitted =
// !arg` is true only when omitted; capture the explicit dash first since
// both read the same `arg` value.
const explicitStdin = arg === '-';
const argOmitted = !arg;

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
//   - omitted --arg      → undefined; compile.rb applies its own default
//                          (#220 — no --arg flag is forwarded at all, below)
//   - explicit `--arg -` → the parent's real piped stdin (RED-397)
//   - `--arg <file>`     → undefined; compile.rb reads the file itself
let compileInput;
if (explicitStdin) {
  try {
    compileInput = readExplicitStdinArg('cambium run');
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(2);
  }
} else {
  compileInput = undefined;
}
// #220: forward --arg only when the user supplied it, mirroring
// cli/compile.mjs's rubyArgs construction — an omission stays an
// omission all the way to compile.rb, instead of being forged into
// `--arg -` + stdin `'{}'` here.
const rubyArgs = [RUBY_COMPILE_SCRIPT, file, '--method', method];
if (!argOmitted) rubyArgs.push('--arg', arg);
const compile = spawnSync('ruby', rubyArgs, {
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
  // #223 DEC-001/DEC-002: `cambium run <pipeline>` with no --arg is a
  // hard refusal when the pipeline declares >=1 `input` slot, not a
  // substitution. A slot is mandatory by construction (no `optional:`/
  // `default:` on `input`), so an omission is always a caller mistake,
  // never a legitimate invocation — refuse it here, before `loadRunner()`
  // and before any dispatch, so a mis-invocation costs nothing. Gated on
  // the compiled IR's own `kind` and `input` -- compile.rb's class
  // registry is still the authority (#220 DEC-001); the CLI reads its
  // answer back, it does not re-derive one. Confined to this caller:
  // `parsePipelineInputs` and `compile.rb` are both untouched, so
  // `cambium serve`, `cambium replay`, and library callers of
  // `runPipelineFromIr` are wholly unaffected by this refusal (#220
  // DEC-005 tried the binder for this and leaked; see
  // records/CHANGE-220-run-arg-bakein-2026-09-03.md and
  // records/AUDIT-220-round1-2026-09-03.md AUD-001). A zero-slot
  // pipeline is untouched and still runs.
  if (argOmitted && isPipeline) {
    const slotNames = Object.keys(ir.input ?? {});
    if (slotNames.length > 0) {
      console.error(
        `cambium run: pipeline "${ir.name}" declares input slot(s) ` +
          `${slotNames.map((n) => `:${n}`).join(', ')} but no value was supplied ` +
          `(--arg was omitted, or given as an empty string). ` +
          `A declared input slot is required -- supply a value one of these ways:\n` +
          `  --arg <path>            read the value from a file` +
          (slotNames.length > 1
            ? ` (a JSON object keyed by slot name: {${slotNames
                .map((n) => `"${n}": ...`)
                .join(', ')}})`
            : '') +
          `\n` +
          `  --arg -                 read the value from piped stdin` +
          (slotNames.length > 1
            ? ` (same: a JSON object keyed by slot name)`
            : '') +
          `\n` +
          `  (remove the \`input\` declaration if this pipeline genuinely needs no input)`,
      );
      process.exit(2);
    }
  }
  const runner = await loadRunner();
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
