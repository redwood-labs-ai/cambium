/**
 * #255 (follow-up to #210/#212) — the VS Code LSP's schema-name
 * discovery was a sixth un-migrated `export const` regex, invisible to
 * `export { X }` / `export function X` / alias idioms the shared
 * classifier (`cli/schema-export.mjs`) already handles for every other
 * call site. `vscode/cambium-syntax/src/schema-names.js` (DEC-004) now
 * routes both server.js scan sites through the classifier's
 * `listExports`, resolved FROM THE SERVED WORKSPACE (DEC-001) rather
 * than bundled or copied.
 *
 * This file has no `vscode-languageserver` import — plain CJS,
 * requirable directly from vitest (same cross-tree precedent as
 * `schema_export_parity.test.ts` importing `cli/schema-export.mjs`).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { listSchemaNames, resolveModulePath } = require_(
  '../../../vscode/cambium-syntax/src/schema-names.js',
);

const REPO_ROOT = process.cwd();
const CANONICAL_MODULE_SOURCE = readFileSync(
  join(REPO_ROOT, 'cli/schema-export.mjs'),
  'utf8',
);

const ALIAS_FORM = `const Baz = Type.Object({});\nexport { Baz as Alias };\n`;

describe('vscode LSP schema-names helper (#255)', () => {
  it('link 1 — resolves against the in-tree cambium repo (this repo\'s own cli/)', () => {
    expect(resolveModulePath(REPO_ROOT)).toBe(join(REPO_ROOT, 'cli/schema-export.mjs'));
  });

  it('link 1 — in-tree resolution: declarations and export-list entries are discovered', async () => {
    const content = `export const Foo = Type.Object({});\nexport const Bar = Type.Object({});\n`;
    const names = await listSchemaNames(REPO_ROOT, content);
    expect(names.map((n: { name: string }) => n.name)).toEqual(['Foo', 'Bar']);
  });

  it('link 1 — alias-form export (`export { X as Y }`) is discovered', async () => {
    const names = await listSchemaNames(REPO_ROOT, ALIAS_FORM);
    expect(names.map((n: { name: string }) => n.name)).toContain('Alias');
  });

  it('revert-proof: alias-form export is BLIND to the deleted `export const` regex the old server.js used', () => {
    // The exact pattern server.js carried at both scan sites before #255
    // (schemas.ts:171 and contracts.ts:346 on pre-#255 main).
    const OLD_REGEX = /^export const (\w+)\s*=/;
    const lines = ALIAS_FORM.split('\n');
    const found = lines.some((l) => OLD_REGEX.test(l));
    expect(found).toBe(false); // red under the old logic — this is the bug #255 fixes
  });

  it('link 2 — resolves an external app\'s installed @redwood-labs/cambium package', async () => {
    // realpath: require.resolve returns real paths, and on macOS tmpdir()
    // sits under the /var -> /private/var symlink.
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-lsp-installed-')));
    const pkgDir = join(workspaceRoot, 'node_modules/@redwood-labs/cambium');
    mkdirSync(join(pkgDir, 'cli'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@redwood-labs/cambium', version: '0.0.0' }),
    );
    // Real canonical source, copied at test time (never a static
    // committed fixture copy) so this test tracks the module as it
    // actually behaves rather than a snapshot that could drift.
    writeFileSync(join(pkgDir, 'cli/schema-export.mjs'), CANONICAL_MODULE_SOURCE);

    expect(resolveModulePath(workspaceRoot)).toBe(
      join(pkgDir, 'cli/schema-export.mjs'),
    );

    const names = await listSchemaNames(workspaceRoot, ALIAS_FORM);
    expect(names.map((n: { name: string }) => n.name)).toContain('Alias');
  });

  it('degrade (DEC-002): unresolvable workspace returns an empty list, never throws', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'cambium-lsp-degrade-'));
    // Empty dir — neither link resolves.
    expect(resolveModulePath(workspaceRoot)).toBeNull();
    await expect(listSchemaNames(workspaceRoot, ALIAS_FORM)).resolves.toEqual([]);
  });
});
