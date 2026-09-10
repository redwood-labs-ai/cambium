/**
 * #210 + #212 — end-to-end regressions for the three ticket repros,
 * run as full CLI flows (scaffold, THEN compile) rather than unit-level
 * checks on either half alone. Each repro is verbatim from
 * `records/AUDIT-206-round1-2026-09-03.md`.
 *
 * All three would have failed against `main`'s pre-#210/#212 behavior:
 *   1. AUD-206-01 — `cambium new schema` correctly skipped the
 *      export-list idiom (post-#206), but `cambium compile` then died
 *      with `Unknown schema 'ProbeReport'` and an EMPTY available list
 *      — the compiler's single `export const` pattern never saw it.
 *   2. AUD-206-02 — `cambium new schema` did NOT skip `export function
 *      <Name>` (pattern 3's `^\s*` anchor excluded every `export
 *      <keyword>` form but `export const`) — it appended a colliding
 *      declaration.
 *   3. AUD-206-03 — `cambium new schema` did NOT skip a barrel
 *      `export * from` file (no pattern could see it) — it appended a
 *      stub that silently shadowed the real re-exported schema with no
 *      tsc diagnostic, AND the compiler's single-pattern scan could
 *      never resolve a barrel file's schema either.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-210-212-repro-'));
  writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runScaffold(args: string[]) {
  const r = spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return { status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

function runCompile(gen: string) {
  const r = spawnSync('node', [CLI, 'compile', gen, '--method', 'analyze'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return { status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

function writeGen(name: string, returnsSchema: string): string {
  const gen = join(scratch, `${name}.cmb.rb`);
  writeFileSync(gen, `
class ${name} < GenModel
  model "omlx:stub"
  system "inline"
  returns ${returnsSchema}

  def analyze(input)
    generate "go" do
      with context: input
      returns ${returnsSchema}
    end
  end
end
`.trim());
  return gen;
}

describe('#210/#212 end-to-end repros (AUDIT-206-round1)', () => {
  it('AUD-206-01 repro: engine-mode export-list idiom — scaffold skip THEN compile succeeds', () => {
    // Runtime-identical to `export const ProbeReport`, ESM named export:
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `import { Type } from '@sinclair/typebox';\n`
        + `const ProbeReport = Type.Object({ summary: Type.String() }, { additionalProperties: false, $id: 'ProbeReport' });\n`
        + `export { ProbeReport };\n`,
    );

    const scaffold = runScaffold(['new', 'schema', 'ProbeReport']);
    expect(scaffold.status, scaffold.output).toBe(0);
    expect(scaffold.output).toMatch(/already exported.*\(skipped\)/);
    expect(scaffold.output).not.toMatch(/appended:/);

    const gen = writeGen('ProbeGen', 'ProbeReport');
    const compiled = runCompile(gen);
    // Pre-#210 this died: `Unknown schema 'ProbeReport'` with an EMPTY
    // "Available schemas" list, even though the schema is right there.
    expect(compiled.status, compiled.output).toBe(0);
    expect(compiled.output).not.toMatch(/Unknown schema/);
    const ir = JSON.parse(readFileSync(join(scratch, 'ProbeGen.ir.json'), 'utf8'));
    expect(ir.returnSchemaId).toBe('ProbeReport');
  });

  it('AUD-206-02 repro: `export function <Name>` — scaffold skip AND compile succeeds', () => {
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `import { Type } from '@sinclair/typebox';\n`
        + `export function Widget() { return Type.Object({}); }\n`,
    );

    const scaffold = runScaffold(['new', 'schema', 'Widget']);
    expect(scaffold.status, scaffold.output).toBe(0);
    expect(scaffold.output).toMatch(/already exported.*\(skipped\)/);
    expect(scaffold.output).not.toMatch(/appended:/);
    // The pre-#212 append would have inserted a second, colliding
    // `export const Widget` declaration — confirm the file is untouched.
    const body = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    expect(body.match(/\bWidget\b/g) ?? []).toHaveLength(1);

    const gen = writeGen('WidgetGen', 'Widget');
    const compiled = runCompile(gen);
    expect(compiled.status, compiled.output).toBe(0);
    expect(compiled.output).not.toMatch(/Unknown schema/);
    const ir = JSON.parse(readFileSync(join(scratch, 'WidgetGen.ir.json'), 'utf8'));
    expect(ir.returnSchemaId).toBe('Widget');
  });

  it('AUD-206-03 repro: a barrel `export * from` schemas.ts — scaffold refuses to append AND compile no longer dead-ends', () => {
    writeFileSync(join(scratch, 'schemas.ts'), `export * from './domain';\n`);

    const scaffold = runScaffold(['new', 'schema', 'Widget']);
    expect(scaffold.status, scaffold.output).toBe(0);
    // Fail-safe direction: refuse to append rather than risk silently
    // shadowing a re-exported name with no tsc diagnostic (AUD-206-03).
    expect(scaffold.output).toMatch(/already exported.*\(skipped\)/);
    expect(scaffold.output).not.toMatch(/appended:/);
    const body = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    expect(body).toBe(`export * from './domain';\n`);

    const gen = writeGen('BarrelGen', 'Widget');
    const compiled = runCompile(gen);
    // Pre-#210 the single-pattern scan could never resolve a barrel
    // file's schema and would hard-stop here with `Unknown schema`.
    // 'unknowable' proceeds — enforcement defers to the runner.
    expect(compiled.status, compiled.output).toBe(0);
    expect(compiled.output).not.toMatch(/Unknown schema/);
    const ir = JSON.parse(readFileSync(join(scratch, 'BarrelGen.ir.json'), 'utf8'));
    expect(ir.returnSchemaId).toBe('Widget');
  });
});
