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
import { writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { readExplicitStdinArg } from './stdin-arg.mjs';
import { detectWorkspaceShape } from './workspace-shape.mjs';
import { fileURLToPath } from 'node:url';

// Resolve the Ruby compile script relative to the CLI's own location,
// not process.cwd(). Engine-mode users invoke `cambium compile` from
// their host project directory — `./ruby/cambium/compile.rb` is
// nowhere on their filesystem. Surfaced by the RED-220 POC.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUBY_COMPILE_SCRIPT = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');

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
  const rubyArgs = [RUBY_COMPILE_SCRIPT, file, '--method', method];
  if (arg !== null) rubyArgs.push('--arg', arg);

  // RED-397: an explicit `--arg -` makes compile.rb do STDIN.read; forward
  // the parent's piped stdin (spawnSync doesn't connect it otherwise).
  let compileInput;
  if (arg === '-') {
    try {
      compileInput = readExplicitStdinArg('cambium compile');
    } catch (err) {
      console.error(err?.message ?? String(err));
      process.exit(2);
    }
  }

  const compile = spawnSync('ruby', rubyArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    input: compileInput,
  });
  if (compile.status !== 0) {
    console.error(compile.stdout || '');
    console.error(compile.stderr || '');
    process.exit(compile.status ?? 1);
  }

  writeFileSync(outputPath, compile.stdout);
  console.error(`Wrote IR to ${outputPath}`);
}

// ── cambium compile (no file) — compile-all (RED-407) ─────────────────
//
// Mode-aware, Rails-style: engine mode materializes the committed
// `<base>.ir.json` artifacts (≈ `assets:precompile`); app mode is
// validate-only (≈ `zeitwerk:check`) — compile every gen, report, write
// nothing — unless `--out-dir`/`--write` opts into materializing. Enumerates
// from the filesystem (all gens on disk), not Genfile exports, so an
// undeclared/internal gen never gets silently skipped.

/** Walk up from `startDir` to the nearest `cambium.engine.json` sentinel. */
function findEngineDir(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'cambium.engine.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Non-recursive scan of `dir` for files ending in any of `exts`. */
function scanByExt(dir, exts) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .sort()
    .map((f) => join(dir, f));
}

/** Output IR filename for a gen / pipeline source. */
function irOutputName(file) {
  const b = basename(file);
  if (b.endsWith('.pipeline.rb')) return b.slice(0, -'.pipeline.rb'.length) + '.pipeline.ir.json';
  if (b.endsWith('.cmb.rb')) return b.slice(0, -'.cmb.rb'.length) + '.ir.json';
  return b + '.ir.json';
}

export async function runCompileAll(args) {
  let outDir = null;
  let writeFlag = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out-dir') outDir = args[++i];
    else if (a === '--write') writeFlag = true;
    else if (a === '--help' || a === '-h') {
      console.error(`
Usage:
  cambium compile                 Recompile every gen/pipeline IR in the workspace.

  Engine mode (cambium.engine.json): writes each <base>.ir.json next to its gen.
  App mode (Genfile.toml): validate-only — compiles every gen, reports, writes
  nothing (the runtime recompiles on the fly). Use --out-dir/--write to materialize.

Flags:
  --out-dir <dir>   Write all IRs into <dir> (created if needed). Implies write.
  --write           Materialize IRs next to each source even in app mode.
`);
      process.exit(0);
    } else bail(`Unknown flag for compile-all: ${a}`);
  }

  const cwd = process.cwd();
  const engineDir = findEngineDir(cwd);

  let files;
  let mode;
  if (engineDir) {
    mode = 'engine';
    files = scanByExt(engineDir, ['.cmb.rb', '.pipeline.rb']);
  } else {
    let ws;
    try {
      ws = detectWorkspaceShape(cwd);
    } catch (e) {
      bail(e?.message ?? String(e));
    }
    if (!ws) {
      bail(
        `cambium compile: not in a Cambium workspace — no Genfile.toml or cambium.engine.json found from ${cwd}.`,
      );
    }
    mode = 'app';
    files = [
      ...scanByExt(join(ws.appPkgRoot, 'app', 'gens'), ['.cmb.rb']),
      ...scanByExt(join(ws.appPkgRoot, 'app', 'pipelines'), ['.pipeline.rb']),
    ];
  }

  if (files.length === 0) {
    console.error(`cambium compile: no gens or pipelines found (${mode} mode).`);
    process.exit(0);
  }

  // Engine mode always writes (the committed artifact); app mode writes only
  // when explicitly asked.
  const willWrite = mode === 'engine' || writeFlag || !!outDir;
  const resolvedOutDir = outDir ? resolve(cwd, outDir) : null;
  if (resolvedOutDir) mkdirSync(resolvedOutDir, { recursive: true });

  const failures = [];
  let written = 0;
  for (const file of files) {
    const rel = relative(cwd, file);
    const res = spawnSync('ruby', [RUBY_COMPILE_SCRIPT, file], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.status !== 0) {
      const msg = (res.stderr || res.stdout || 'compile failed').trim().split('\n').slice(0, 4).join('\n');
      failures.push({ file: rel, msg });
      console.error(`  ✗ ${rel}`);
      continue;
    }
    if (willWrite) {
      const out = resolvedOutDir
        ? join(resolvedOutDir, irOutputName(file))
        : join(dirname(file), irOutputName(file));
      writeFileSync(out, res.stdout);
      written += 1;
      console.error(`  ✓ ${rel} → ${relative(cwd, out)}`);
    } else {
      console.error(`  ✓ ${rel}`);
    }
  }

  const ok = files.length - failures.length;
  console.error('');
  if (failures.length === 0) {
    if (willWrite) {
      console.error(`cambium compile: wrote ${written} IR file(s) (${mode} mode).`);
    } else {
      console.error(
        `cambium compile: validated ${ok} gen(s) — all compile ✓ ` +
          `(no IRs written; app mode compiles at runtime — use --out-dir <dir> to materialize).`,
      );
    }
    process.exit(0);
  }

  console.error(`cambium compile: ${ok}/${files.length} ok, ${failures.length} failed:`);
  for (const f of failures) {
    console.error(`  ✗ ${f.file}\n      ${f.msg.replace(/\n/g, '\n      ')}`);
  }
  process.exit(1);
}
