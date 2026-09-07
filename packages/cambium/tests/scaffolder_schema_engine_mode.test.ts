/**
 * #206 (issue #158 follow-up, AUD-158-01 parity gap): engine-mode
 * `generateSchema` (`cli/generate.mjs`, appends to `<engineDir>/schemas.ts`)
 * carried the same fail-open existing-name detection that DEC-158-007
 * fixed for app mode's `src/contracts.ts` — a single `export const <Name>`
 * regex that misses a hand-authored `const X = …; export { X }` idiom.
 * #206 ports the fail-closed three-pattern detection to engine mode via a
 * shared helper (`schemaNameAlreadyPresent`), used by both branches.
 *
 * Mirrors packages/cambium/tests/scaffolder_schema_app_mode.test.ts, but
 * uses the engine-mode fixture (`cambium.engine.json` sentinel + spawning
 * from inside that directory) established in scaffolder_engine_mode.test.ts,
 * since engine mode has no Genfile.toml.
 *
 * Test 3 below is the engine-mode equivalent of the AUD-158-01 repro:
 * before #206, a hand-authored `schemas.ts` exporting via
 * `const X = …; export { X }` was NOT detected as already-present, and
 * `cambium new schema X` silently appended a second, colliding
 * `const`/`$id` declaration — confirmed to fail red against the pre-fix
 * code, green after (see the change record for the red-run transcript).
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
  scratch = mkdtempSync(join(tmpdir(), 'cambium-scaffold-schema-engine-'));
  writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

describe('#206: cambium new schema engine-mode write/skip (shared schemaNameAlreadyPresent)', () => {
  it('fresh file: creates schemas.ts with the TypeBox import and the export', () => {
    const r = runCli(['new', 'schema', 'FreshOne']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);

    const schemasPath = join(scratch, 'schemas.ts');
    expect(existsSync(schemasPath)).toBe(true);
    const body = readFileSync(schemasPath, 'utf8');
    expect(body).toMatch(/import \{ Type \} from '@sinclair\/typebox'/);
    expect(body).toMatch(/export const FreshOne/);

    // F-1 (AUDIT-206 round 1): pin the engine branch by assertion, not by
    // circumstance — engine mode's tail message is "Next step: use in your
    // gen"; app mode's is "Then use in your agent". Without this, the test
    // only proves app mode is unreachable from tmpdir(), not that engine
    // mode actually ran.
    expect(r.stdout).toMatch(/Next step: use in your gen/);
  });

  it('literal `export const <Name>` already present: skips instead of duplicating', () => {
    const original = `import { Type } from '@sinclair/typebox';\n\nexport const Existing = Type.Object({}, { additionalProperties: false, $id: 'Existing' });\n`;
    writeFileSync(join(scratch, 'schemas.ts'), original);

    const r = runCli(['new', 'schema', 'Existing']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);

    const body = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    expect(body).toBe(original);
    expect(body.match(/export const Existing\b/g) ?? []).toHaveLength(1);
  });

  it('AUD-158-01-equivalent repro: `export { X }`-idiom already present skips instead of corrupting the file', () => {
    // Engine-mode analogue of the AUD-158-01 repro from
    // records/AUDIT-158-round1-2026-09-01.md: a hand-authored schemas.ts
    // that exports via `const X = …; export { X }` rather than a literal
    // `export const`.
    const original =
      `import { Type } from '@sinclair/typebox';\n` +
      `const HandRolled = Type.Object(\n` +
      `  { note: Type.String() },\n` +
      `  { additionalProperties: false, $id: 'HandRolled' },\n` +
      `);\n` +
      `export { HandRolled };\n`;
    writeFileSync(join(scratch, 'schemas.ts'), original);

    const r = runCli(['new', 'schema', 'HandRolled']);
    expect(r.status, (r.stderr ?? '') + (r.stdout ?? '')).toBe(0);
    // Pre-fix, this was `appended: HandRolled → ...` and the "already
    // exported, skipped" branch never fired — the bug #206 ports the fix for.
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/already exported.*\(skipped\)/);
    expect((r.stdout ?? '') + (r.stderr ?? '')).not.toMatch(/appended:/);

    const body = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    expect(body).toBe(original);
    // No second `const HandRolled` / `$id: 'HandRolled'` declaration — the
    // corruption class this test guards against must not happen.
    expect(body.match(/\bHandRolled\b/g) ?? []).toHaveLength(3); // const decl, $id, export{}
  });
});
