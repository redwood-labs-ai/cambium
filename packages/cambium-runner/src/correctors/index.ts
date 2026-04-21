import type { CorrectorFn, CorrectorResult } from './types.js';
import { math } from './math.js';
import { dates } from './dates.js';
import { currency } from './currency.js';
import { citations } from './citations.js';

export type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

// RED-299: per-`runGen` corrector registry. Replaces the mutable
// module-global that RED-275 introduced — see `docs/GenDSL Docs/N -
// Engine-Mode Corrector Registry Isolation (RED-281).md` for the
// design rationale.
//
// Framework-built-in correctors are exported as `builtinCorrectors`
// for hosts that want to merge them with their own (the conventional
// pattern for engine-mode callers). The CLI does this automatically.
// `runCorrectorPipeline` now takes the correctors map as a parameter
// rather than reading a module-global.
export const builtinCorrectors: Readonly<Record<string, CorrectorFn>> = Object.freeze({
  math, dates, currency, citations,
});

// RED-275 back-compat: `registerAppCorrectors` was the only way to
// install app correctors before RED-299. Hosts that still call it
// write into this private legacy map; the runner merges it into
// per-call correctors at lowest precedence (just above built-ins,
// below `opts.correctors`). New callers should use
// `RunGenOptions.correctors` instead.
const legacyAppCorrectors: Record<string, CorrectorFn> = {};
const warnedOverrides = new Set<string>();
let deprecationWarned = false;

/**
 * @deprecated RED-299: pass `correctors` via `RunGenOptions` instead.
 * This function still works for backward compatibility but writes into
 * a process-global legacy map, which defeats per-`runGen` isolation in
 * long-lived hosts. Emits a one-time stderr deprecation warning.
 */
export function registerAppCorrectors(extras: Record<string, CorrectorFn>): void {
  if (!deprecationWarned) {
    deprecationWarned = true;
    console.error(
      '[cambium] registerAppCorrectors is deprecated (RED-299); pass correctors via RunGenOptions.correctors instead.',
    );
  }
  for (const [name, fn] of Object.entries(extras)) {
    if (name in builtinCorrectors && !warnedOverrides.has(name)) {
      warnedOverrides.add(name);
      console.error(
        `[cambium] app corrector "${name}" overrides the framework built-in`,
      );
    }
    legacyAppCorrectors[name] = fn;
  }
}

/**
 * @internal Exported only so the runner and tests can read the legacy
 * map. Host code must NOT call this — it would let one app read
 * another app's correctors in a long-lived process, defeating the
 * per-`runGen` isolation RED-299 enforces. Use `RunGenOptions.correctors`.
 */
export function _getLegacyAppCorrectors(): Record<string, CorrectorFn> {
  return { ...legacyAppCorrectors };
}

/**
 * Test-only: clear the legacy registry + warning state. The tests in
 * `registry.test.ts` exercise the deprecated path directly and need
 * teardown between cases. Production code should never call this.
 */
export function _resetLegacyCorrectorsForTests(): void {
  for (const name of Object.keys(legacyAppCorrectors)) delete legacyAppCorrectors[name];
  warnedOverrides.clear();
  deprecationWarned = false;
}

export function runCorrectorPipeline(
  names: string[],
  data: any,
  context: { document?: string },
  correctors: Record<string, CorrectorFn>,
): { data: any; results: CorrectorResult[] } {
  const results: CorrectorResult[] = [];
  let current = data;

  for (const name of names) {
    const fn = correctors[name];
    if (!fn) {
      throw new Error(`Unknown corrector: "${name}". Available: ${Object.keys(correctors).join(', ')}`);
    }
    let result: CorrectorResult;
    try {
      result = fn(current, context);
    } catch (e: any) {
      // Don't crash the run on a throwing corrector — synthesize an
      // error issue so the repair loop can feed it back to the LLM.
      // RED-275: app correctors are user code and shouldn't be able
      // to take the run down.
      result = {
        corrected: false,
        output: current,
        issues: [
          {
            path: '',
            message: `corrector "${name}" threw: ${e?.message ?? String(e)}`,
            severity: 'error',
          },
        ],
      };
    }
    results.push(result);
    if (result.corrected) {
      current = result.output;
    }
  }

  return { data: current, results };
}
