/**
 * #242: unit tests for the shared `resolveCompileRb` chain — the single
 * resolver that replaced `enrich.ts`'s, `pipeline.ts`'s, and `serve.ts`'s
 * three independently-drifted copies. Precedence, highest first:
 * explicit param → CAMBIUM_COMPILE_RB → createRequire sibling → in-tree
 * dev fallback.
 *
 * Integration-level proof that `pipeline.ts` and `serve.ts` actually
 * *consume* this resolver (not just that the resolver itself is
 * correct) lives in `pipeline-compile-rb.test.ts` and
 * `serve/serve.test.ts`'s "compileRb precedence" describe block.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompileRb } from './compile-rb.js';

// The real in-tree compile.rb this repo ships — the dev-fallback link
// (4) resolves to this when nothing else is set. Used both to assert
// the fallback link's own behavior and to confirm the sibling fixture
// below is a *different* file (so a test can tell which link fired).
const REAL_DEV_COMPILE_RB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'ruby/cambium/compile.rb',
);

// Node's createRequire resolution walks up from this module's own
// directory (packages/cambium-runner/src/) through ancestor
// node_modules/ folders. Planting a fake `@redwood-labs/cambium`
// package right here — the first node_modules Node will check — lets
// us exercise link 3 with a real (uncommitted, gitignored) npm-install
// layout instead of mocking node:module.
const FAKE_SIBLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'node_modules', '@redwood-labs', 'cambium');
const FAKE_SIBLING_COMPILE_RB = join(FAKE_SIBLING_ROOT, 'ruby', 'cambium', 'compile.rb');

function plantFakeSibling(): void {
  mkdirSync(join(FAKE_SIBLING_ROOT, 'ruby', 'cambium'), { recursive: true });
  writeFileSync(join(FAKE_SIBLING_ROOT, 'package.json'), JSON.stringify({ name: '@redwood-labs/cambium', version: '0.0.0-test' }));
  writeFileSync(FAKE_SIBLING_COMPILE_RB, '# fake sibling compile.rb fixture for #242 tests\n');
}

function removeFakeSibling(): void {
  rmSync(resolve(dirname(fileURLToPath(import.meta.url)), 'node_modules'), { recursive: true, force: true });
}

describe('resolveCompileRb (#242)', () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.CAMBIUM_COMPILE_RB;
    delete process.env.CAMBIUM_COMPILE_RB;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
    else process.env.CAMBIUM_COMPILE_RB = prevEnv;
    removeFakeSibling();
  });

  it('link 4: falls back to the in-tree dev path when nothing else is set', () => {
    expect(existsSync(REAL_DEV_COMPILE_RB)).toBe(true);
    expect(resolveCompileRb()).toBe(REAL_DEV_COMPILE_RB);
  });

  it('link 3 beats link 4: createRequire sibling wins over the dev fallback', () => {
    plantFakeSibling();
    const result = resolveCompileRb();
    expect(result).toBe(FAKE_SIBLING_COMPILE_RB);
    expect(result).not.toBe(REAL_DEV_COMPILE_RB);
  });

  it('link 2 beats links 3+4: CAMBIUM_COMPILE_RB wins even when a sibling exists', () => {
    plantFakeSibling();
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env-precedence';
    expect(resolveCompileRb()).toBe('/nonexistent/compile.rb.env-precedence');
  });

  it('link 1 beats everything: explicit param wins over env var, sibling, and fallback', () => {
    plantFakeSibling();
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env';
    expect(resolveCompileRb('/explicit/compile.rb.wins')).toBe('/explicit/compile.rb.wins');
  });

  it('treats an empty-string explicit param as absent (falls through to the next link)', () => {
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env';
    expect(resolveCompileRb('')).toBe('/nonexistent/compile.rb.env');
  });

  it('treats a whitespace-only CAMBIUM_COMPILE_RB as absent (falls through to link 3/4)', () => {
    process.env.CAMBIUM_COMPILE_RB = '   ';
    expect(resolveCompileRb()).toBe(REAL_DEV_COMPILE_RB);
  });
});
