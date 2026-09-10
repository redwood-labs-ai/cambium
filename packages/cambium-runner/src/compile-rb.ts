import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #242: single resolver for `ruby/cambium/compile.rb`, replacing three
 * independently-maintained chains that had drifted (`enrich.ts`'s
 * `resolveDefaultCompileRb`, `pipeline.ts`'s private helper of the same
 * name, `serve.ts`'s inline chain) — `serve.ts`'s was the weakest: no
 * `createRequire` sibling link, so it broke under a standard npm install
 * (its own comment said so). See Forgejo #242 and
 * `records/CHANGE-242-2026-09-09.md`.
 *
 * Precedence, highest first:
 *
 *   1. `explicit` param — trusted as given (non-empty check only, no
 *      `existsSync`). Threaded from `RunGenFromIrOptions.compileRb` /
 *      `RunPipelineFromIrOptions.compileRb` / `RunServeOptions.compileRb`,
 *      which the CLI (`cli/serve.mjs`, `cli/mcp.mjs`) already resolves
 *      from its own on-disk location and passes down.
 *   2. `CAMBIUM_COMPILE_RB` env var — operator escape hatch. Same trust
 *      level as (1): no existence check here either.
 *   3. Production npm install: this module resolved at
 *      `<install>/node_modules/@redwood-labs/cambium-runner/{dist,src}/compile-rb.{js,ts}`,
 *      compile.rb at the sibling `@redwood-labs/cambium` package's
 *      `ruby/cambium/compile.rb`. Resolved via `createRequire` so it
 *      works across package-manager layouts. Existence-checked.
 *   4. In-tree development / monorepo fallback: this module at
 *      `<repo>/packages/cambium-runner/{src,dist}/compile-rb.{ts,js}`,
 *      compile.rb at `<repo>/ruby/cambium/compile.rb`. Existence-checked.
 *
 * Returns `null` when nothing resolves — deliberately not a throw. This
 * is a straight lift of `enrich.ts`'s original `resolveDefaultCompileRb`
 * body, whose nullable-return contract both pre-existing callers already
 * build a MORE appropriate reaction on top of than a generic throw from
 * here would give them: `enrich.ts` degrades a single enrichment field
 * gracefully (`EnrichCompileError` trace step, run continues);
 * `pipeline.ts` fails the whole pipeline run eagerly with a clear message
 * (via its own `existsSync`-and-throw immediately after calling this).
 * `serve.ts` didn't previously distinguish "unresolved" from "resolved
 * but nonexistent" at all (see DEV-001/DEV-002 in the change record for
 * how that gap is closed at the call site, not by changing this
 * contract). Widening this signature to throw would take that choice
 * away from both existing, deliberately-different callers.
 */
export function resolveCompileRb(explicit?: string): string | null {
  if (explicit && explicit.trim()) return explicit;

  const envCompileRb = process.env.CAMBIUM_COMPILE_RB;
  if (envCompileRb && envCompileRb.trim()) return envCompileRb;

  try {
    const req = createRequire(import.meta.url);
    const cambiumPkg = req.resolve('@redwood-labs/cambium/package.json');
    const candidate = resolve(dirname(cambiumPkg), 'ruby/cambium/compile.rb');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Falls through to in-tree dev resolution below.
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const dev = resolve(here, '../../..', 'ruby/cambium/compile.rb');
  if (existsSync(dev)) return dev;

  return null;
}
