/**
 * #242 acceptance criterion: "a test that would fail if a fourth
 * divergent resolver appeared." Scans every non-test `.ts` file under
 * `packages/cambium-runner/src/` (other than `compile-rb.ts` itself)
 * for the fingerprint of a from-scratch `ruby/cambium/compile.rb`
 * resolver: a real `process.env.CAMBIUM_COMPILE_RB` read, or a real
 * quoted `'ruby/cambium/compile.rb'` path literal used as a resolve/join
 * argument.
 *
 * Deliberately narrow, not a bare substring match on `CAMBIUM_COMPILE_RB`
 * or `ruby/cambium/compile.rb`: both names are legitimately *mentioned*
 * in prose (doc comments) and in operator-facing error-message strings
 * across `enrich.ts`, `pipeline.ts`, `serve.ts`, `runner.ts` — pointing
 * at `compile-rb.ts#resolveCompileRb` or telling an operator which env
 * var to set. Only the literal, quoted, code-shaped forms below are
 * fingerprinted; see CHANGE-242-2026-09-09.md for the false positives
 * this ruled out and why they're safe to allow.
 *
 * Also guards against a resolver for a *different* target file reusing
 * the same package-sibling trick under a different env-var name (see
 * `memory/retro-agent.ts`'s `CAMBIUM_CLI` / `cli/cambium.mjs` resolver,
 * a legitimate, unrelated, out-of-scope sibling) by fingerprinting on
 * `CAMBIUM_COMPILE_RB` / `ruby/cambium/compile.rb` specifically, not on
 * the createRequire-sibling *pattern* in general.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const FINGERPRINTS: RegExp[] = [
  /process\.env\.CAMBIUM_COMPILE_RB\b/,
  /process\.env\[\s*['"]CAMBIUM_COMPILE_RB['"]\s*\]/,
  /['"]ruby\/cambium\/compile\.rb['"]/,
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('compile.rb resolver — no divergent copies (#242)', () => {
  it('is the only file under packages/cambium-runner/src/ matching the resolver fingerprint', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      if (file === join(SRC_DIR, 'compile-rb.ts')) continue;
      const contents = readFileSync(file, 'utf8');
      if (FINGERPRINTS.some((re) => re.test(contents))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
