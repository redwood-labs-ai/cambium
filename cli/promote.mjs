// ── cambium promote (#199) ─────────────────────────────────────────────
//
// Turn a prior run into permanent regression armor in one move:
//
//   1. Write the run's input document into <app>/examples/fixtures/.
//   2. Mint a deterministic --mock snapshot for it (DEC-001 — promote
//      never copies the source run's output.json; it always spawns a
//      fresh `cambium run ... --mock` against the just-promoted fixture
//      and snapshots THAT stdout. A copied snapshot from a real,
//      non-mock run can never equal the golden's --mock assertion, and
//      minting is what makes promote work on failed runs too — only
//      ir.json is required, output.json is optional).
//   3. Wire (or extend) <app>/tests/<snake>.test.ts to both, reusing the
//      exact template `cambium new agent` scaffolds (goldenTestSource).
//
//   cambium promote <run-id>
//   cambium promote runs/run_20260910_143902_ab12cd --source page_text
//   cambium promote <run-id> --force
//
// See docs/GenDSL Docs/P - cambium promote.md.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectScaffoldContext, goldenTestSource, snakeCase } from './generate.mjs';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const CAMBIUM_MJS = join(CLI_DIR, 'cambium.mjs');

// Path-traversal guard (CLAUDE.md's guard table), applied to the bare-id
// form BEFORE it is joined onto `<cwd>/runs/`. Matches the exact shape
// `runner.ts` generates (run_<8-digit date>_<6-digit time>_<6 hex>) —
// tighter than the generic safe-segment guard other symbol-into-path
// sites use, which costs nothing here since the shape is fixed (DEC-006).
const RUN_ID_REGEX = /^run_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;

// Context keys are Ruby hash keys from `with context: {...}` (or the
// implicit single-key form) — conventionally snake_case identifiers.
// Guarded the same way before being interpolated into the promoted
// fixture's filename (DEC-003): `--source` lets an operator name one
// directly, so this is a symbol-into-path join site too.
const CONTEXT_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// DEC-010: the run directory promote reads is UNTRUSTED input — the
// path form of <run-id|path> may point at a bundle the operator didn't
// generate (received from a teammate, downloaded from CI, attached to a
// bug report — exactly the "field failure" story #199's own docs
// describe). `ir.entry.class` reaches `snakeCase` → a `path.join` for
// every target filename (AUD-security's traversal PoC); `ir.entry.method`
// reaches a child-process argv in `mintSnapshot`'s spawn. Same identifier
// family as `generate.mjs`'s `NAME_REGEX`/`validateName` — anchored, so a
// traversal-shaped value can never partially match.
const ENTRY_IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

// The scaffold's literal TODO placeholder (DEC-004 case 2 detection).
const PLACEHOLDER_MARKER = 'examples/fixtures/<fixture>';

export class PromoteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n\n`);
  process.stderr.write(`Usage: cambium promote <run-id|path> [options]

Turn a prior run into a fixture + deterministic golden test in one move.

Trust boundary: run directories are UNTRUSTED input (DEC-010) — only
promote runs you generated yourself or otherwise trust.

Options:
  --source <key>   Which ir.context key to promote (required when the run's
                    context has zero or more than one eligible string key).
  --force           Overwrite an existing fixture/snapshot. Never rewrites an
                    already-wired test file (DEC-004) — that's not --force's
                    to override.
  -h, --help        Show this help

Examples:
  cambium promote run_20260910_143902_ab12cd
  cambium promote runs/run_20260910_143902_ab12cd --source page_text
  cambium promote run_20260910_143902_ab12cd --force
`);
  process.exit(msg ? 2 : 0);
}

/**
 * Resolve `<run-id|path>` to an existing run directory (DEC-006).
 * Path form: contains a separator or starts with '.'. Id form: must
 * match RUN_ID_REGEX before it is ever joined onto `<cwd>/runs/`.
 * Either form must resolve (after realpath) to a directory containing a
 * readable ir.json; output.json is NOT required (a failed run has none).
 */
export function resolveRunDir(runRef, cwd) {
  const looksLikePath = runRef.includes('/') || runRef.startsWith('.');
  let dir;
  if (looksLikePath) {
    dir = resolve(cwd, runRef);
  } else {
    if (!RUN_ID_REGEX.test(runRef)) {
      throw new PromoteError(
        2,
        `Invalid run id "${runRef}". Expected shape: run_<8-digit date>_<6-digit time>_<6 hex chars> ` +
          `(e.g. run_20260910_143902_ab12cd), or pass a path to the run directory.`,
      );
    }
    dir = join(cwd, 'runs', runRef);
  }

  let real;
  try {
    real = realpathSync(dir);
  } catch {
    throw new PromoteError(
      2,
      `Run not found: ${dir}. Pass a run-id (resolved under <cwd>/runs/) or a path to the run directory.`,
    );
  }

  if (!existsSync(join(real, 'ir.json'))) {
    throw new PromoteError(2, `No ir.json at ${real} — not a run directory.`);
  }
  return real;
}

/** Read + structurally validate ir.json (DEC-006: gen shape; DEC-010: the
 *  whole consumed field surface, fail-closed, before any downstream use —
 *  the run directory is UNTRUSTED input, not just the run-ref argument
 *  that names it). */
export function readIr(runDir) {
  const irPath = join(runDir, 'ir.json');
  let ir;
  try {
    ir = JSON.parse(readFileSync(irPath, 'utf8'));
  } catch (e) {
    throw new PromoteError(2, `Failed to parse ${irPath}: ${e?.message ?? e}`);
  }

  const isGenShape = typeof ir?.entry?.class === 'string' && Array.isArray(ir?.steps);
  if (!isGenShape) {
    if (ir?.kind === 'Pipeline') {
      throw new PromoteError(
        2,
        `${runDir} is a Pipeline run. cambium promote is gens-first — pipeline-run ` +
          `promotion is a deliberate non-goal (see #199 non-goals).`,
      );
    }
    throw new PromoteError(2, `${irPath} doesn't look like a gen IR (missing entry.class or steps[]).`);
  }

  // DEC-010 (a)/(b): entry.class reaches a path.join (via snakeCase, for
  // every target filename); entry.method reaches a child-process argv
  // (mintSnapshot's spawn). Both untrusted, both guarded before any use.
  if (!ENTRY_IDENTIFIER_REGEX.test(ir.entry.class)) {
    throw new PromoteError(
      2,
      `${irPath}: entry.class "${ir.entry.class}" doesn't look like a safe identifier ` +
        `(expected ${ENTRY_IDENTIFIER_REGEX}). Run directories are UNTRUSTED input (DEC-010) — ` +
        `refusing to use it to derive a filename.`,
    );
  }
  if (typeof ir.entry.method !== 'string' || !ENTRY_IDENTIFIER_REGEX.test(ir.entry.method)) {
    throw new PromoteError(
      2,
      `${irPath}: entry.method ${JSON.stringify(ir.entry.method)} doesn't look like a safe identifier ` +
        `(expected ${ENTRY_IDENTIFIER_REGEX}). Run directories are UNTRUSTED input (DEC-010) — ` +
        `refusing to pass it to a child process.`,
    );
  }
  // DEC-010 (c), syntactic half: entry.source must be a string ending in
  // .cmb.rb. The workspace-containment half (realpath + relative()
  // escape check) needs the resolved workspace root and runs in
  // resolveScaffoldContext, immediately before entry.source is ever
  // joined onto a path — see AUD-001.
  if (typeof ir.entry.source !== 'string' || !ir.entry.source.endsWith('.cmb.rb')) {
    throw new PromoteError(
      2,
      `${irPath}: entry.source ${JSON.stringify(ir.entry.source)} must be a string ending in ".cmb.rb". ` +
        `Run directories are UNTRUSTED input (DEC-010).`,
    );
  }
  return ir;
}

/** DEC-002: pick the context key to promote. */
export function selectContextKey(ir, explicitSource) {
  const context = ir.context ?? {};
  const keys = Object.keys(context);

  if (explicitSource !== null) {
    if (!Object.prototype.hasOwnProperty.call(context, explicitSource)) {
      throw new PromoteError(
        2,
        `--source "${explicitSource}" is not a key of this run's context. Keys present: ${
          keys.join(', ') || '(none)'
        }.`,
      );
    }
    return explicitSource;
  }

  const eligible = keys.filter((k) => typeof context[k] === 'string' && !k.startsWith('_'));
  if (eligible.length === 1) return eligible[0];
  if (eligible.length === 0) {
    throw new PromoteError(
      2,
      `No eligible context key found (string-valued, not "_"-prefixed). Keys present: ${
        keys.join(', ') || '(none)'
      }. Use --source <key> to name one explicitly.`,
    );
  }
  throw new PromoteError(
    2,
    `Ambiguous context: ${eligible.length} eligible keys (${eligible.join(', ')}). Use --source <key> to pick one.`,
  );
}

/** DEC-002: content sniff for extension — JSON.parse succeeds after
 *  trim, first char {/[  → .json, else .txt. */
export function sniffExtension(text) {
  const trimmed = text.trim();
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Looked JSON-ish but isn't — falls through to .txt.
    }
  }
  return 'txt';
}

/** Resolve the promoted key's value to fixture bytes + extension. Non-string
 *  values (explicit --source of a non-string / `_`-prefixed key) are
 *  serialized as pretty-printed JSON (DEC-002). */
export function resolveFixtureContent(value) {
  if (typeof value === 'string') {
    return { content: value, ext: sniffExtension(value) };
  }
  return { content: JSON.stringify(value, null, 2), ext: 'json' };
}

/** DEC-005: resolve `<app>` exactly the way `cambium new` does.
 *
 * DEC-010 / AUD-001: `ir.entry.source` is read from an UNTRUSTED run
 * directory and reaches `mintSnapshot`'s child-process argv — a value
 * that gets `load`ed as Ruby. A plain `path.join` does not stop a `..`
 * escape (it normalizes the segments syntactically rather than clamping
 * to a base directory — CLAUDE.md's guard-table warning, and exactly how
 * AUD-001's PoC escaped the workspace). Resolve, realpath, and apply the
 * same RED-222-style `relative()` containment check
 * `correctors/app-loader.ts` uses for a symlinked corrector — BEFORE
 * `existsSync`/`realpathSync` is ever trusted to mean "safe". Returns
 * the validated, realpath'd `genPath` alongside `ctx` so
 * `mintSnapshot` never re-derives it from the raw field. Exported for
 * direct unit-testing of the containment check (AUD-005). */
export function resolveScaffoldContext(cwd, ir) {
  const ctx = detectScaffoldContext(cwd);
  if (ctx.mode === 'engine') {
    throw new PromoteError(
      2,
      `cambium promote does not support engine mode (${ctx.engineDir}). Engine folders have no ` +
        `examples/fixtures/ or tests/ convention to write into.`,
    );
  }
  if (ctx.mode !== 'app') {
    throw new PromoteError(
      2,
      `No Cambium app workspace detected at or above ${cwd}. cd into a workspace with app/gens/ ` +
        `(or a Genfile.toml) and retry.`,
    );
  }

  let workspaceRootReal;
  try {
    workspaceRootReal = realpathSync(ctx.workspaceRoot);
  } catch (e) {
    throw new PromoteError(2, `Could not resolve the workspace root ${ctx.workspaceRoot}: ${e?.message ?? e}`);
  }

  const genPathCandidate = resolve(ctx.workspaceRoot, ir.entry.source);
  let genPath;
  try {
    genPath = realpathSync(genPathCandidate);
  } catch {
    throw new PromoteError(
      2,
      `This run's gen source ("${ir.entry.source}") does not exist relative to the detected ` +
        `workspace (${ctx.workspaceRoot}) — the artifact may have been compiled elsewhere. Run ` +
        `promote from the workspace the gen actually lives in.`,
    );
  }
  const rel = relative(workspaceRootReal, genPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PromoteError(
      2,
      `Refusing to trust this run's entry.source ("${ir.entry.source}") — it resolves outside the ` +
        `workspace (${ctx.workspaceRoot}). Run directories are UNTRUSTED input (DEC-010): only ` +
        `promote runs you generated yourself or otherwise trust.`,
    );
  }
  return { ...ctx, genPath };
}

/** DEC-003: compute the fixed target paths. */
export function computeTargets(ctx, ir, key, ext) {
  const PKG = ctx.appPkgRoot;
  const pascal = ir.entry.class;
  const snake = snakeCase(pascal);
  return {
    PKG,
    pascal,
    snake,
    fixturePath: join(PKG, 'examples/fixtures', `${snake}-promoted-${key}.${ext}`),
    snapshotPath: join(PKG, 'examples/fixtures', `${snake}-snapshot.json`),
    testPath: join(PKG, 'tests', `${snake}.test.ts`),
  };
}

/** DEC-008: all-or-nothing preflight over the machine-owned artifacts
 *  (fixture + snapshot). The test file is never gated by --force — its
 *  own three-case rule (DEC-004) decides independently. */
export function preflight(targets, force) {
  const collisions = [targets.fixturePath, targets.snapshotPath].filter((p) => existsSync(p));
  if (collisions.length > 0 && !force) {
    throw new PromoteError(
      2,
      `Refusing to overwrite existing file(s) without --force:\n${collisions
        .map((p) => `  ${p}`)
        .join('\n')}\nNothing written.`,
    );
  }
}

/** DEC-001: mint the snapshot with a fresh --mock run against the
 *  just-promoted fixture, via this CLI's own entry point. Never copies
 *  the source run's output.json.
 *
 *  Spawns `ctx.genPath` — the containment-checked, realpath'd path
 *  `resolveScaffoldContext` derived (DEC-010) — never the raw
 *  `ir.entry.source` field. That field named the exact spawn AUD-001's
 *  RCE PoC exploited; re-deriving it here would silently reopen the
 *  hole even though `resolveScaffoldContext` validated it upstream. */
function mintSnapshot({ ctx, ir, fixturePath }) {
  const result = spawnSync(
    process.execPath,
    [CAMBIUM_MJS, 'run', ctx.genPath, '--method', ir.entry.method, '--arg', fixturePath, '--mock'],
    { cwd: ctx.workspaceRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new PromoteError(
      1,
      `Minting the --mock snapshot failed (the fixture was already written to ${fixturePath}):\n${
        result.stderr || '(no stderr)'
      }`,
    );
  }
  return result.stdout;
}

// Matches the scaffold's `const FIXTURE = ...` declaration in BOTH shapes:
//
//   const FIXTURE = "/abs/path"                    (pre-#282 scaffolds)
//   const FIXTURE = join(PKG_ROOT, "rel/path")     (#282 and later)
//
// Capturing group 1 is `join(PKG_ROOT, ` when the path is PKG-anchored, else
// undefined; group 2 is the FULL JSON string literal (quotes included), since
// both shapes emit the path via `JSON.stringify` (#199 DEC-012) — parse it
// with JSON.parse to recover the assigned value. Promote must keep reading
// pre-#282 test files it did not write, so the legacy shape stays matchable
// forever; only what promote WRITES moves to the PKG-anchored form.
const FIXTURE_LINE_REGEX = /^const FIXTURE = (join\(PKG_ROOT, )?(".*?")\)?$/m;

// Matches the scaffold's `const GEN = ...` declaration (DEC-011, DEC-012) —
// same two shapes as FIXTURE_LINE_REGEX above. Used only to WARN on a
// mismatch for an already-existing test (cases 2/3 below never edit it —
// same human-owned-file reasoning as DEC-004's FIXTURE rule).
const GEN_LINE_REGEX = /^const GEN = (join\(PKG_ROOT, )?(".*?")\)?$/m;

/** Recover the absolute path a matched GEN/FIXTURE line refers to (#282).
 *
 * A PKG-anchored line (`join(PKG_ROOT, "app/gens/x.cmb.rb")`) resolves
 * against the app package root, because that is exactly what `PKG_ROOT`
 * evaluates to at run time — the test file lives at `<appPkgRoot>/tests/`.
 * A legacy line already holds an absolute path and is returned as-is. The
 * result is directly comparable with `genRel` / `fixturePathForTest`, which
 * are always absolute, so the DEC-004 placeholder check and the AUD-002
 * mismatch warning behave identically across both shapes. */
function resolveLineValue(match, appPkgRoot) {
  if (!match) return null;
  const literal = JSON.parse(match[2]);
  return match[1] ? join(appPkgRoot, literal) : literal;
}

/** Emit a GEN/FIXTURE line in the #282 PKG-anchored form when the path lies
 * inside the app package, else the legacy absolute literal. Mirrors
 * `goldenTestSource`'s own `pkgRel` so a line promote REWRITES and a line the
 * scaffolder WRITES are the same shape for the same path. */
function pathLine(name, absPath, appPkgRoot) {
  const rel = relative(appPkgRoot, absPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return `const ${name} = join(PKG_ROOT, ${JSON.stringify(rel.split(sep).join('/'))})`;
  }
  return `const ${name} = ${JSON.stringify(absPath)}`;
}

/** DEC-004: three-case test wiring. Never rewrites an already-wired test.
 *
 * The placeholder check looks ONLY at the FIXTURE const's own assigned
 * value, never the whole file — the scaffold's docstring ("1. Create a
 * fixture: .../examples/fixtures/<fixture>.txt") repeats the same marker
 * string as generic instructional text and stays in the file forever,
 * including in a test promote itself just wired. Matching the whole file
 * would misclassify every already-wired test as "still placeholder" and
 * rewrite it on every subsequent promote — exactly the data-loss risk
 * DEC-004 exists to prevent.
 *
 * `genRel` (DEC-011) is the run's validated, workspace-relative
 * `entry.source` — passed to `goldenTestSource` for case 1 (a fresh
 * test's `GEN` line is derived from the artifact that actually produced
 * this mint, not a filename convention that may not hold). Cases 2/3
 * never edit an existing `GEN` line, but the result reports whether it
 * matches `genRel` so the caller can warn instead of silently shipping a
 * golden that runs the wrong file (AUD-002). */
export function wireTest({ ctx, pascal, snake, method, testPath, fixturePathForTest, genRel }) {
  if (!existsSync(testPath)) {
    const source = goldenTestSource({ ctx, pascal, snake, method, fixtureRel: fixturePathForTest, genRel });
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(testPath, source);
    return { action: 'created' };
  }

  const existing = readFileSync(testPath, 'utf8');
  const fixtureLineMatch = existing.match(FIXTURE_LINE_REGEX);
  const fixtureValue = resolveLineValue(fixtureLineMatch, ctx.appPkgRoot);
  const hasPlaceholder = fixtureValue !== null && fixtureValue.includes(PLACEHOLDER_MARKER);
  const genLineMatch = existing.match(GEN_LINE_REGEX);
  const genLine = genLineMatch ? genLineMatch[0] : null;
  const genValue = resolveLineValue(genLineMatch, ctx.appPkgRoot);
  const genMatches = genLineMatch ? genValue === genRel : null; // null: no GEN line to compare

  if (hasPlaceholder) {
    const updated = existing.replace(
      FIXTURE_LINE_REGEX,
      // Function form, not a template string: the second argument to
      // String.prototype.replace is otherwise a replacement PATTERN, where
      // `$&`/`$'`/`$1`/`$$` have special meaning — unreachable today
      // (upstream regex guards keep `$` out of fixturePathForTest), but a
      // defense-in-depth conversion so a JSON-stringified path is always
      // inserted literally.
      () => pathLine('FIXTURE', fixturePathForTest, ctx.appPkgRoot),
    );
    writeFileSync(testPath, updated);
    return { action: 'wired', genLine, genMatches };
  }

  return {
    action: 'untouched',
    fixtureLine: fixtureLineMatch ? fixtureLineMatch[0] : '(no FIXTURE line found)',
    matches: fixtureValue !== null ? fixtureValue === fixturePathForTest : false,
    genLine,
    genMatches,
  };
}

// #199 DEC-012 (Low): strip control characters (including ANSI escape
// bytes, \x1b, itself within this range) before echoing an untrusted
// field to the terminal. Run directories are UNTRUSTED input (DEC-010) —
// `wired.genLine` comes from a test file a prior (possibly untrusted)
// promote wrote, and `ir.entry.source` comes straight off the run's
// ir.json — neither should be able to plant terminal escape sequences.
function stripControlChars(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

/** DEC-011: for a test wireTest left in place (cases 2/3 — the GEN line
 *  is never edited), print a visible warning naming both paths when the
 *  wired GEN doesn't match this run's own entry.source. Silent otherwise
 *  (including when there's no GEN line to compare at all). */
function warnGenMismatch(wired, ir) {
  if (wired.genMatches === false) {
    console.log(`  WARNING: this test's GEN line does not match this run's gen source.`);
    console.log(`    test: ${stripControlChars(wired.genLine)}`);
    console.log(`    run:  const GEN = '${stripControlChars(ir.entry.source)}'`);
  }
}

export async function runPromote(args) {
  if (args.includes('--help') || args.includes('-h')) usage();

  const runRef = args[0];
  if (!runRef || runRef.startsWith('-')) usage('Missing <run-id|path>');

  let source = null;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') source = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`Unknown flag: ${a}`);
  }

  const cwd = process.cwd();

  try {
    const runDir = resolveRunDir(runRef, cwd);
    const ir = readIr(runDir);

    if (!existsSync(join(runDir, 'output.json'))) {
      process.stderr.write(`Note: ${runDir} has no output.json (a failed run) — promoting its input anyway.\n`);
    }

    const key = selectContextKey(ir, source);
    if (!CONTEXT_KEY_REGEX.test(key)) {
      throw new PromoteError(
        2,
        `Context key "${key}" doesn't look like a safe identifier (expected /${CONTEXT_KEY_REGEX.source}/) — ` +
          `refusing to use it in a filename.`,
      );
    }
    const { content, ext } = resolveFixtureContent(ir.context[key]);

    const ctx = resolveScaffoldContext(cwd, ir);
    const targets = computeTargets(ctx, ir, key, ext);

    preflight(targets, force);

    mkdirSync(dirname(targets.fixturePath), { recursive: true });
    writeFileSync(targets.fixturePath, content);
    console.log(`  wrote fixture: ${targets.fixturePath}`);

    const stdout = mintSnapshot({ ctx, ir, fixturePath: targets.fixturePath });

    writeFileSync(targets.snapshotPath, stdout);
    console.log(`  wrote snapshot: ${targets.snapshotPath}`);

    const wired = wireTest({
      ctx,
      pascal: targets.pascal,
      snake: targets.snake,
      method: ir.entry.method,
      testPath: targets.testPath,
      fixturePathForTest: targets.fixturePath,
      genRel: ir.entry.source,
    });

    if (wired.action === 'created') {
      console.log(`  created test: ${targets.testPath}`);
    } else if (wired.action === 'wired') {
      console.log(`  wired FIXTURE in existing test: ${targets.testPath}`);
      warnGenMismatch(wired, ir);
    } else {
      console.log(`  left test untouched (already wired): ${targets.testPath}`);
      console.log(`    ${wired.fixtureLine}`);
      if (!wired.matches) {
        console.log(`    note: this does not match the fixture just promoted (${targets.fixturePath}).`);
      }
      warnGenMismatch(wired, ir);
    }

    console.log(`\nNext: npx vitest run ${targets.testPath}`);
  } catch (err) {
    if (err instanceof PromoteError) {
      console.error(err.message);
      process.exit(err.code);
    }
    console.error(err?.stack || String(err));
    process.exit(1);
  }
}
