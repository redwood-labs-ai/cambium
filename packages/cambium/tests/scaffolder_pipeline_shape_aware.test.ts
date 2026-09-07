/**
 * #158 amendment round 2 (DEC-158-005 / DEC-158-006): `cambium new
 * pipeline` must produce a scaffold that
 *
 *   (a) compiles out of the box — the `${pascal}Input` schema is
 *       scaffolded via the existing `generateSchema` path instead of
 *       left undeclared with only a "next steps" instruction, and
 *   (b) has a generated pipeline test that resolves the CLI the same
 *       shape-aware way the agent test template already does, instead
 *       of hardcoding a monorepo-only `ruby ruby/cambium/compile.rb`
 *       invocation that cannot resolve outside this repo.
 *
 * Mirrors the `runCli` / flat-`[package]`-scratch pattern already used
 * by `scaffolder_returns_block.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-scaffold-pipeline-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[], cwd = scratch) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

// What an out-of-tree scaffolded test must contain instead of a bare
// `npx cambium`: the scoped dependency, resolved by Node.
const CLI_RESOLUTION =
  /CAMBIUM: string\[\] = \[process\.execPath, createRequire\(import\.meta\.url\)\.resolve\('@redwood-labs\/cambium\/cli\/cambium\.mjs'\)\]/;

describe('#158 round 2: cambium new pipeline (DEC-158-005 / DEC-158-006)', () => {
  it('DEC-158-005: generated pipeline test has no monorepo-hardcoded ruby path in a [package]-shaped workspace', () => {
    // Flat [package] workspace with no cambium-runner sibling — NOT
    // in-tree, so `hasInTreeRunnerSource` must fall back to npx.
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "pipelineshape"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'pipeline', 'Triage']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const testPath = join(scratch, 'tests', 'triage.pipeline.test.ts');
    expect(existsSync(testPath)).toBe(true);
    const body = readFileSync(testPath, 'utf8');

    // The old bug: a bare `ruby ruby/cambium/compile.rb ...` invocation,
    // unreachable outside the monorepo (issue #158 finding 5).
    expect(body).not.toMatch(/ruby ruby\/cambium\/compile\.rb/);
    // The fix: the same shape-aware CAMBIUM invocation the agent test
    // template uses (DEC-158-005) — this scratch has no in-tree
    // cambium-runner, so it resolves the `@redwood-labs/cambium`
    // dependency through Node module resolution (round 4 below: never a
    // bare `npx cambium`).
    expect(body).toMatch(CLI_RESOLUTION);
    expect(body).not.toMatch(/['"]npx['"]/);
  });

  it('DEC-158-006: fresh `cambium new pipeline` compiles out of the box (workspace-wide compile all-ok)', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "pipelineschema"\nversion = "0.0.0"\n`);
    const gen = runCli(['new', 'pipeline', 'Triage']);
    expect(gen.status, (gen.stderr ?? '') + (gen.stdout ?? '')).toBe(0);

    // The Input schema must have actually landed in contracts.ts, not
    // just been printed as a "next steps" instruction (issue #158
    // finding 7 — `ruby/cambium/pipeline.rb#input` requires `schema:`).
    const contractsPath = join(scratch, 'src', 'contracts.ts');
    expect(existsSync(contractsPath)).toBe(true);
    expect(readFileSync(contractsPath, 'utf8')).toMatch(/export const TriageInput/);

    const compile = runCli(['compile']);
    const compileOutput = (compile.stderr ?? '') + (compile.stdout ?? '');
    expect(compile.status, compileOutput).toBe(0);
    expect(compileOutput).toMatch(/all compile/);
    expect(compileOutput).not.toMatch(/failed/);
  });

  it('generateSchema is idempotent: re-running `cambium new pipeline` with the same name does not duplicate the export', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "pipelineidem"\nversion = "0.0.0"\n`);
    // First run creates app/pipelines/triage.pipeline.rb + the schema.
    expect(runCli(['new', 'pipeline', 'Triage']).status).toBe(0);
    // Second run: the pipeline file itself is skipped (writeFile's
    // overwrite protection), but generateSchema runs again — must
    // report the "already exported (skipped)" branch, not append twice.
    const second = runCli(['new', 'pipeline', 'Triage']);
    expect(second.status, (second.stderr ?? '') + (second.stdout ?? '')).toBe(0);
    expect((second.stdout ?? '') + (second.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);

    const contracts = readFileSync(join(scratch, 'src', 'contracts.ts'), 'utf8');
    const occurrences = contracts.match(/export const TriageInput\b/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

describe('#158 round 4: scaffolded tests never resolve the CLI through a bare `npx cambium`', () => {
  // The unscoped `cambium` on the npm registry is an unrelated third-party
  // package, and `npm exec` assumes --yes when stdin is not a TTY or CI is
  // detected — so a generated test that ran `npx cambium` in a workspace
  // whose dependency wasn't installed yet would download and execute a
  // stranger's code. Both templates resolve `@redwood-labs/cambium`
  // through Node module resolution instead.
  it('agent test template ([package] workspace): resolves @redwood-labs/cambium, no npx', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "agentshape"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'agent', 'Triage']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const body = readFileSync(join(scratch, 'tests', 'triage.test.ts'), 'utf8');
    expect(body).toMatch(/^import \{ createRequire \} from 'node:module'$/m);
    expect(body).toMatch(CLI_RESOLUTION);
    expect(body).not.toMatch(/['"]npx['"]/);
  });

  it('the resolution expression finds the installed dependency from inside the workspace', () => {
    // Stand in for `npm install`: link this repo as the scoped dependency
    // and evaluate the exact expression the templates emit from a file
    // inside the scratch workspace.
    mkdirSync(join(scratch, 'node_modules', '@redwood-labs'), { recursive: true });
    symlinkSync(REPO_ROOT, join(scratch, 'node_modules', '@redwood-labs', 'cambium'), 'dir');
    mkdirSync(join(scratch, 'tests'), { recursive: true });
    const probe = join(scratch, 'tests', 'resolve-probe.mjs');
    writeFileSync(probe, [
      "import { createRequire } from 'node:module'",
      "process.stdout.write(createRequire(import.meta.url).resolve('@redwood-labs/cambium/cli/cambium.mjs'))",
      '',
    ].join('\n'));
    const r = spawnSync(process.execPath, [probe], { cwd: scratch, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.endsWith(join('cli', 'cambium.mjs'))).toBe(true);
    expect(existsSync(r.stdout)).toBe(true);
  });

  it('in-tree scaffolds are untouched: the agent template still spawns cli/cambium.mjs directly', () => {
    // hasInTreeRunnerSource is true when a `cambium-runner/src` sibling
    // exists next to the app package — fake that shape in the scratch.
    mkdirSync(join(scratch, 'packages', 'cambium-runner', 'src'), { recursive: true });
    mkdirSync(join(scratch, 'packages', 'app'), { recursive: true });
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/app"]\n`);
    writeFileSync(join(scratch, 'packages', 'app', 'Genfile.toml'), `[package]\nname = "app"\nversion = "0.0.0"\n`);
    const r = runCli(['new', 'agent', 'Triage']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const body = readFileSync(join(scratch, 'packages', 'app', 'tests', 'triage.test.ts'), 'utf8');
    expect(body).toMatch(/CAMBIUM: string\[\] = \['node', join\(REPO_ROOT, 'cli\/cambium\.mjs'\)\]/);
    expect(body).not.toMatch(/createRequire/);
    expect(body).not.toMatch(/['"]npx['"]/);
  });
});
