#!/usr/bin/env node
/**
 * `cambium schedule <preview|list|compile>` (RED-305).
 *
 *   preview <gen.cmb.rb> [--count N]  — print next N fires per declared schedule
 *   list                               — walk the workspace, list every schedule
 *   compile <workspace> --target <t>  — emit deploy-ready manifests for a scheduler
 *
 * All three are static analyses on compiled IR + cron math. No daemon,
 * no runtime lifecycle — operator-facing tooling.
 */

import { spawnSync } from 'node:child_process';
import {
  readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileScheduleTarget, availableTargets,
} from './schedule-targets/index.mjs';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUBY_COMPILE_SCRIPT = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');
const FIXTURE_DEFAULT = resolve(
  CLI_DIR, '..', 'packages/cambium/examples/fixtures/incident.txt',
);

function bail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

// Compile a .cmb.rb file to IR via the Ruby compiler. We walk the gen
// file once per schedule operation — not ideal for a 100-gen workspace,
// but all we need for v1.
function compileToIR(genFile, method) {
  const rubyArgs = [RUBY_COMPILE_SCRIPT, genFile, '--method', method, '--arg', FIXTURE_DEFAULT];
  const res = spawnSync('ruby', rubyArgs, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`ruby compile failed for ${genFile}:\n${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

// Walk a directory for .cmb.rb files (one level; we trust app/gens/ convention).
function walkGens(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walkGens(full));
    else if (name.endsWith('.cmb.rb')) out.push(full);
  }
  return out;
}

// Compute the next N fires for a 5-field crontab expression.
// Supports: digit literals, "*", comma lists, "-" ranges, "*/step".
// Not exhaustive — v1 covers the named-vocab outputs + common raw forms.
function nextFires(expr, count, tz = 'UTC') {
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const now = new Date();
  const out = [];
  // Iterate minute-by-minute up to a safe horizon (1 year).
  const horizon = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  let t = new Date(now.getTime() + 60 * 1000); // start at next minute
  t.setSeconds(0, 0);
  while (out.length < count && t <= horizon) {
    if (matchesField(minF, t.getUTCMinutes(), 0, 59) &&
        matchesField(hourF, t.getUTCHours(), 0, 23) &&
        matchesField(domF, t.getUTCDate(), 1, 31) &&
        matchesField(monF, t.getUTCMonth() + 1, 1, 12) &&
        matchesField(dowF, t.getUTCDay(), 0, 7)) {
      out.push(t.toISOString());
    }
    t = new Date(t.getTime() + 60 * 1000);
  }
  return out;
}

function matchesField(field, value, min, max) {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some((f) => matchesField(f, value, min, max));
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = Number(stepStr);
    const base = range === '*' ? min : Number(range);
    return value >= base && (value - base) % step === 0;
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    // day-of-week special: 7 = Sun = 0
    const v = (value === 0 && max === 7) ? 7 : value;
    return v >= lo && v <= hi;
  }
  const n = Number(field);
  if (max === 7) {
    // day-of-week: 0 and 7 both mean Sunday
    if (n === 0 || n === 7) return value === 0;
  }
  return n === value;
}

// ─── preview ────────────────────────────────────────────────────────
async function cmdPreview(args) {
  if (args.length === 0) bail('Usage: cambium schedule preview <gen.cmb.rb> [--count N]');
  const genFile = args[0];
  let count = 5;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--count') count = Number(args[++i]);
  }

  // We need a --method to compile; for preview we don't have one, so
  // compile-and-retry: if ruby errors on multi-method, user passes
  // explicit method. For now, try with the gen's first discovered
  // method by parsing the gen file's `def` lines.
  const firstMethod = firstMethodName(genFile);
  if (!firstMethod) bail(`No public method found in ${genFile}.`);

  const ir = compileToIR(genFile, firstMethod);
  const schedules = ir?.policies?.schedules ?? [];
  if (schedules.length === 0) {
    console.log(`No schedules declared in ${basename(genFile)}.`);
    return;
  }

  for (const s of schedules) {
    console.log(`\n${s.id}  (${s.expression}, tz=${s.tz})`);
    console.log(`  method: ${s.method}`);
    const fires = nextFires(s.expression, count, s.tz);
    if (fires.length === 0) {
      console.log('  (no fires in the next year — check your cron expression)');
    } else {
      for (const f of fires) console.log(`  ${f}`);
    }
  }
}

function firstMethodName(genFile) {
  const src = readFileSync(genFile, 'utf8');
  const m = src.match(/^\s*def\s+([a-z_][a-z0-9_]*)/m);
  return m ? m[1] : null;
}

// ─── list ───────────────────────────────────────────────────────────
async function cmdList(args) {
  const gensDir = args[0] ?? 'app/gens';
  const gens = walkGens(gensDir);
  if (gens.length === 0) {
    console.log(`No .cmb.rb files under ${gensDir}.`);
    return;
  }
  console.log('Declared schedules:\n');
  let total = 0;
  for (const gen of gens) {
    const method = firstMethodName(gen);
    if (!method) continue;
    let ir;
    try { ir = compileToIR(gen, method); }
    catch { continue; }
    const schedules = ir?.policies?.schedules ?? [];
    for (const s of schedules) {
      console.log(`  ${s.id}`);
      console.log(`    gen:    ${basename(gen)}`);
      console.log(`    when:   ${s.expression} (tz=${s.tz})`);
      console.log(`    method: ${s.method}\n`);
      total += 1;
    }
  }
  if (total === 0) console.log('(no schedules declared)');
}

// ─── compile ────────────────────────────────────────────────────────
async function cmdCompile(args) {
  let gensDir = null;
  let target = null;
  let outDir = null;
  let image = null;
  let region = null;
  let plan = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') target = args[++i];
    else if (a === '--out-dir') outDir = args[++i];
    else if (a === '--image') image = args[++i];
    else if (a === '--region') region = args[++i];
    else if (a === '--plan') plan = args[++i];
    else if (a === '--force') force = true;
    else if (!a.startsWith('-')) gensDir = a;
    else bail(`Unknown flag: ${a}`);
  }

  // Input hardening: reject newlines/control-chars in operator-supplied
  // strings before they land in YAML / crontab output. Not a security
  // boundary (operator IS the user), but prevents confusing malformed
  // manifest bugs.
  for (const [name, value] of Object.entries({ image, region, plan })) {
    if (value && /[\n\r\t]/.test(value)) {
      bail(`--${name} must not contain whitespace or control characters (got ${JSON.stringify(value)}).`);
    }
  }
  gensDir ??= 'app/gens';
  if (!target) {
    bail(`Usage: cambium schedule compile <gens-dir> --target <${availableTargets().join('|')}> [--out-dir <dir>] [--image <img>]`);
  }
  if (!availableTargets().includes(target)) {
    bail(`Unknown --target ${target}. Available: ${availableTargets().join(', ')}.`);
  }

  const config = { image, region, plan };
  const gens = walkGens(gensDir);
  if (gens.length === 0) bail(`No .cmb.rb files under ${gensDir}.`);

  const outputs = [];
  for (const genFile of gens) {
    const method = firstMethodName(genFile);
    if (!method) continue;
    let ir;
    try { ir = compileToIR(genFile, method); }
    catch (e) { console.error(`skipping ${genFile}: ${e.message}`); continue; }

    const schedules = ir?.policies?.schedules ?? [];
    if (schedules.length === 0) continue;

    const className = ir?.entry?.class ?? basename(genFile, '.cmb.rb');
    const snakeClass = className
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase();
    const gen = {
      className,
      snakeClass,
      sourcePath: genFile,
      absolutePath: resolve(genFile),
    };

    for (const s of schedules) {
      const content = compileScheduleTarget(target, s, gen, config);
      outputs.push({ schedule: s, content });
    }
  }

  if (outputs.length === 0) {
    console.log(`No schedules to emit for target ${target}.`);
    return;
  }

  // Write behavior depends on target shape:
  // - crontab: single stream to stdout (or --out-dir/cambium.cron)
  // - systemd: object { filename: content } — multiple files
  // - others: one file per schedule
  // Overwrite guard: a second `compile` run silently clobbering hand-
  // edited manifests is a real operator footgun. Require --force to
  // overwrite, same stance as cli/scaffold-tool.mjs.
  const writeGuarded = (path, text) => {
    if (existsSync(path) && !force) {
      bail(
        `Refusing to overwrite ${path}. Pass --force to replace, or --out-dir <fresh-dir>.`,
      );
    }
    writeFileSync(path, text);
    console.error(`Wrote ${path}`);
  };

  if (target === 'crontab') {
    const text = outputs.map((o) => o.content).join('\n');
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeGuarded(join(outDir, 'cambium.cron'), text);
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (outDir) mkdirSync(outDir, { recursive: true });
  for (const { schedule, content } of outputs) {
    if (typeof content === 'string') {
      const name = target === 'github-actions'
        ? `${schedule.id.replace(/\./g, '-')}.yml`
        : `${schedule.id.replace(/\./g, '-')}.${targetExt(target)}`;
      if (outDir) {
        writeGuarded(join(outDir, name), content);
      } else {
        console.log(`# ===== ${name} =====`);
        process.stdout.write(content);
      }
    } else if (typeof content === 'object') {
      // systemd: { filename: text }
      for (const [filename, text] of Object.entries(content)) {
        if (outDir) {
          writeGuarded(join(outDir, filename), text);
        } else {
          console.log(`# ===== ${filename} =====`);
          process.stdout.write(text);
        }
      }
    }
  }
}

function targetExt(target) {
  switch (target) {
    case 'k8s-cronjob': return 'cronjob.yaml';
    case 'render-cron': return 'render.yaml';
    default: return 'txt';
  }
}

export async function runSchedule(args) {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    console.error(`
Usage:
  cambium schedule preview <gen.cmb.rb> [--count N]
  cambium schedule list [<gens-dir>]
  cambium schedule compile <gens-dir> --target <k8s-cronjob|crontab|systemd|github-actions|render-cron> [--out-dir <dir>] [--image <img>]
`);
    process.exit(sub ? 0 : 2);
  }
  if (sub === 'preview') return cmdPreview(rest);
  if (sub === 'list')    return cmdList(rest);
  if (sub === 'compile') return cmdCompile(rest);
  bail(`Unknown subcommand: ${sub}`);
}
