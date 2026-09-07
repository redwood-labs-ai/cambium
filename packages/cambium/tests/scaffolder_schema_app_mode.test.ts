/**
 * #158 round 3 (DEC-158-007 / STEP-002c, closing AUD-158-01 / AUD-158-02):
 * standalone `cambium new schema <Name>` in app mode now writes a real
 * `src/contracts.ts` export instead of print-only instructions
 * (DEC-158-006, round 2) — this file is the dedicated coverage the audit
 * found missing, plus the fail-closed "already present" detection
 * (DEC-158-007) that replaces the single `export const <Name>` regex.
 *
 * Test 3 below is the AUD-158-01 repro verbatim: before DEC-158-007, a
 * hand-authored `contracts.ts` exporting via `const X = …; export { X }`
 * was NOT detected as already-present, and `cambium new schema X`
 * silently appended a second, colliding `const`/`$id` declaration —
 * confirmed to fail red against the pre-fix code, green after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-scaffold-schema-'));
  writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "schemaappmode"\nversion = "0.0.0"\n`);
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

describe('#158 round 3: cambium new schema app-mode write/skip (DEC-158-007)', () => {
  it('fresh file: creates src/contracts.ts with the TypeBox import and the export', () => {
    const r = runCli(['new', 'schema', 'FreshOne']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const contractsPath = join(scratch, 'src', 'contracts.ts');
    expect(existsSync(contractsPath)).toBe(true);
    const body = readFileSync(contractsPath, 'utf8');
    expect(body).toMatch(/import \{ Type \} from '@sinclair\/typebox'/);
    expect(body).toMatch(/export const FreshOne/);
  });

  it('literal `export const <Name>` already present: skips instead of duplicating', () => {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const original = `import { Type } from '@sinclair/typebox'\n\nexport const Existing = Type.Object({}, { additionalProperties: false, $id: 'Existing' })\n`;
    writeFileSync(join(scratch, 'src', 'contracts.ts'), original);

    const r = runCli(['new', 'schema', 'Existing']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);

    const body = readFileSync(join(scratch, 'src', 'contracts.ts'), 'utf8');
    expect(body).toBe(original);
    expect(body.match(/export const Existing\b/g) ?? []).toHaveLength(1);
  });

  it('AUD-158-01 repro: `export { X }`-idiom already present skips instead of corrupting the file', () => {
    // Verbatim reproduction from records/AUDIT-158-round1-2026-09-01.md
    // § AUD-158-01: a hand-authored contracts.ts that exports via
    // `const X = …; export { X }` rather than a literal `export const`.
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const original =
      `import { Type } from '@sinclair/typebox'\n` +
      `const HandRolled = Type.Object(\n` +
      `  { note: Type.String() },\n` +
      `  { additionalProperties: false, $id: 'HandRolled' },\n` +
      `)\n` +
      `export { HandRolled }\n`;
    writeFileSync(join(scratch, 'src', 'contracts.ts'), original);

    const r = runCli(['new', 'schema', 'HandRolled']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    // Pre-fix, this was `appended: HandRolled → ...` and the "already
    // exported, skipped" branch never fired — the bug AUD-158-01 found.
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);
    expect((r.stdout ?? '') + (r.stderr ?? '')).not.toMatch(/appended:/);

    const body = readFileSync(join(scratch, 'src', 'contracts.ts'), 'utf8');
    expect(body).toBe(original);
    // No second `const HandRolled` / `$id: 'HandRolled'` declaration —
    // the corruption AUD-158-01 reproduced (`Cannot redeclare
    // block-scoped variable 'HandRolled'` at the next `tsc`/`npm test`)
    // must not happen.
    expect(body.match(/\bHandRolled\b/g) ?? []).toHaveLength(3); // const decl, $id, export{}
  });

  it('pipeline-invoked path: `cambium new pipeline` skips an already-present `<Name>Input` via the export-list idiom instead of duplicating', () => {
    // The AUD-158-01 report flagged this as reachable "silently, without
    // the developer explicitly choosing to scaffold a schema" — a
    // pipeline named to collide with an existing `<Name>Input` export.
    // (Note: `export { X }` isn't itself a schema idiom the Ruby
    // compiler's own `pipeline.rb#validate_input_schemas` resolves —
    // that scan is a separate, pre-existing `export const`-only regex,
    // out of #158's scope. This test only asserts the scaffolder's
    // append/skip detection, not end-to-end pipeline compilation.)
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const original =
      `import { Type } from '@sinclair/typebox'\n` +
      `const TriageInput = Type.Object(\n` +
      `  { document: Type.String() },\n` +
      `  { additionalProperties: false, $id: 'TriageInput' },\n` +
      `)\n` +
      `export { TriageInput }\n`;
    writeFileSync(join(scratch, 'src', 'contracts.ts'), original);

    const r = runCli(['new', 'pipeline', 'Triage']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);
    expect((r.stdout ?? '') + (r.stderr ?? '')).not.toMatch(/appended:/);

    const body = readFileSync(join(scratch, 'src', 'contracts.ts'), 'utf8');
    expect(body).toBe(original);
    expect(body.match(/\bTriageInput\b/g) ?? []).toHaveLength(3);
  });
});
