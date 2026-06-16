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
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { readExplicitStdinArg } from './stdin-arg.mjs';
import { detectWorkspaceShape } from './workspace-shape.mjs';
import { emitContractsFile, SENTINEL_MARKER } from './contracts-emitter.mjs';
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

// ── RED-419 C3: contracts.generated.ts (block-form schemas) ───────────

/**
 * Pull the inline `returnSchema` (block form) out of a compiled gen's
 * stdout and record it under its class name. Bare-mode compile emits a
 * `{ method → ir }` map; `returnSchema` is gen-level, so it's identical
 * across methods — take it from any one. Symbol-form gens (and pipelines)
 * carry no `returnSchema` and are skipped. Best-effort: a parse hiccup or
 * a gen without a schema is silently ignored (the IR write already
 * succeeded; the contracts file is a convenience, DEC-002).
 *
 * DEC-010: if two block-form gens share the same class name, records the
 * collision in `collisions` (a Map from className → [file1, file2]) for
 * the caller to hard-error before any write. The `out` map stores
 * `{ schema, file }` entries — callers extract `.schema` for emission.
 */
function collectBlockFormSchema(stdout, sourceFile, out, collisions) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return;
  }
  // Bare mode (no --method) → { method → ir }. Take the first method.
  const irs = Object.values(parsed);
  for (const ir of irs) {
    if (ir && typeof ir === 'object' && ir.returnSchema && ir.entry?.class) {
      const className = ir.entry.class;
      if (out[className]) {
        // DEC-010: duplicate class name across block-form gens — record for
        // hard-error. Accumulate all colliders (first file + this file).
        const existing = collisions.get(className) ?? [out[className].file];
        existing.push(sourceFile);
        collisions.set(className, existing);
      } else {
        out[className] = { schema: ir.returnSchema, file: sourceFile };
      }
      return; // gen-level schema is shared across methods
    }
  }
}

/**
 * Resolve the canonical path to `contracts.generated.ts` under `appPkgRoot`,
 * applying the same escape guard used by the write path (DEC-006/DEC-007/
 * DEC-009 / SEC-LOW-3). Fixed filename, no user-supplied segment. Throws if
 * the resolved path escapes the app package root.
 *
 * Single source of truth for both the write path (`writeGeneratedContracts`)
 * and the empty-set delete path — eliminates the asymmetry caught by SEC-LOW-3.
 */
function resolveContractsPath(appPkgRoot) {
  const target = join(appPkgRoot, 'src', 'contracts.generated.ts');
  const rel = relative(appPkgRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `cambium compile: refusing to operate on contracts.generated.ts outside the app package (${target}).`,
    );
  }
  return target;
}

/**
 * Emit `<appPkgRoot>/src/contracts.generated.ts` from the collected
 * block-form schemas, behind the RED-222 code-gen guard family
 * (DEC-006/DEC-007/DEC-009):
 *   - the output path is anchored on the workspace's appPkgRoot (the
 *     same source-of-truth this function already used to enumerate gens),
 *     with a FIXED filename — no user-picked segment joins into the path;
 *   - a `relative()` escape check rejects any resolution outside the
 *     app package (defence-in-depth, since the filename is fixed);
 *   - if the target exists and its first line lacks the `@generated by
 *     cambium` sentinel, it is a hand-authored / foreign file → HARD
 *     ERROR (never clobber human work). With the sentinel → overwrite.
 *
 * Returns the absolute path written.
 */
function writeGeneratedContracts(cwd, schemasByClass) {
  const ws = detectWorkspaceShape(cwd);
  if (!ws) {
    throw new Error(
      'cambium compile: cannot resolve the app package root for contracts.generated.ts ' +
        '(no Genfile.toml found). Block-form gens still run via the inline IR schema.',
    );
  }

  const target = resolveContractsPath(ws.appPkgRoot);
  const srcDir = join(ws.appPkgRoot, 'src');

  // Overwrite guard (DEC-007 / DEC-009): never clobber a non-sentinel file.
  if (existsSync(target)) {
    const firstLine = readFileSync(target, 'utf8').split('\n', 1)[0] ?? '';
    if (!firstLine.includes(SENTINEL_MARKER)) {
      throw new Error(
        `cambium compile: refusing to overwrite ${target} — its first line is missing the ` +
          `Cambium generated-file marker ("${SENTINEL_MARKER}"). This file looks hand-authored. ` +
          `Delete it (or restore the sentinel header) and re-run, or rename your hand-written contracts.`,
      );
    }
  }

  mkdirSync(srcDir, { recursive: true });
  writeFileSync(target, emitContractsFile(schemasByClass));
  return target;
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
  // RED-419 C3: className → { schema, file }, collected across all
  // block-form gens for the wholesale `contracts.generated.ts` regen.
  // DEC-010: collisions tracks duplicate class names for hard-error.
  const blockFormEntries = {};
  const blockFormCollisions = new Map();
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
    collectBlockFormSchema(res.stdout, rel, blockFormEntries, blockFormCollisions);
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

  // DEC-010: class-name uniqueness check — hard-error before any write
  // (consistent with DEC-009's loud-failure posture).
  if (blockFormCollisions.size > 0 && failures.length === 0) {
    for (const [className, files2] of blockFormCollisions) {
      console.error(
        `\ncambium compile: class-name collision — "${className}" is declared as a block-form ` +
          `gen in multiple files:\n${files2.map(f => `  ${f}`).join('\n')}\n` +
          `Gen class names must be unique across the workspace (DEC-003/DEC-010). ` +
          `Rename one of the colliding classes to proceed.`,
      );
    }
    process.exit(1);
  }

  // Flatten { className: { schema, file } } → { className: schema } for the emitter.
  const blockFormSchemas = Object.fromEntries(
    Object.entries(blockFormEntries).map(([k, v]) => [k, v.schema]),
  );

  // RED-419 C3: regenerate src/contracts.generated.ts wholesale from
  // every block-form gen (DEC-003). Only in app mode (engine-mode TS gen
  // is out of scope, DEC-006) and only under --write (a dry compile and
  // an --out-dir IR dump both leave the workspace untouched). Skipped
  // entirely when no gen uses a `returns do` block. A failed compile
  // above (failures.length > 0) means the schema set is incomplete, so we
  // don't rewrite a partial contracts file.
  if (mode === 'app' && writeFlag && failures.length === 0 && Object.keys(blockFormSchemas).length > 0) {
    try {
      const genPath = writeGeneratedContracts(cwd, blockFormSchemas);
      console.error(`  ✓ contracts → ${relative(cwd, genPath)} (${Object.keys(blockFormSchemas).length} block-form gen(s))`);
    } catch (e) {
      console.error(`\n${e?.message ?? String(e)}`);
      process.exit(1);
    }
  }

  // DEC-010 empty-set file lifecycle: the wholesale regen is a pure function
  // (all block-form gens) → file. When the input set becomes empty (all block
  // gens removed or converted to symbol form), the correct output is NO file.
  // If a stale sentinel-marked contracts.generated.ts exists, delete it — it
  // is ours and now stale. If a non-sentinel file is in the way, the
  // DEC-007/009 rule applies: leave it alone (don't touch foreign files).
  if (mode === 'app' && writeFlag && failures.length === 0 && Object.keys(blockFormSchemas).length === 0) {
    try {
      const ws2 = detectWorkspaceShape(cwd);
      if (ws2) {
        // Use the shared helper so the escape guard (SEC-LOW-3) covers
        // both the write path and the delete path identically.
        const stale = resolveContractsPath(ws2.appPkgRoot);
        if (existsSync(stale)) {
          const firstLine = readFileSync(stale, 'utf8').split('\n', 1)[0] ?? '';
          if (firstLine.includes(SENTINEL_MARKER)) {
            // Ours — delete it (stale, no block-form gens remain).
            unlinkSync(stale);
            console.error(`  ✓ contracts → removed ${relative(cwd, stale)} (no block-form gens remain)`);
          } else {
            // Not ours — hard-error per DEC-007/009.
            console.error(
              `\ncambium compile: refusing to remove "${relative(cwd, stale)}" — it does not ` +
                `carry the \`@generated by cambium\` sentinel and may be hand-authored. ` +
                `Delete it manually if it is no longer needed.`,
            );
            process.exit(1);
          }
        }
      }
    } catch (e) {
      console.error(`\n${e?.message ?? String(e)}`);
      process.exit(1);
    }
  }

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
