import type { CorrectorFn, CorrectorResult } from './types.js';
import { math } from './math.js';
import { dates } from './dates.js';
import { currency } from './currency.js';
import { citations } from './citations.js';

export type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

// Mutable per-process registry. Framework built-ins are the baseline;
// `registerAppCorrectors` merges app-supplied correctors on top at
// runner startup (RED-275).
//
// Note on long-lived hosts: this registry is process-global. CLI is
// one-shot so this is fine; engine-mode hosts that load multiple
// unrelated apps in one process would see app correctors from call N
// leak into call N+1. The fix (move to per-`runGen` via `RunGenOptions`,
// matching how tools/actions/schemas already work) is spec'd in the
// design note `docs/GenDSL Docs/N - Engine-Mode Corrector Registry
// Isolation (RED-281).md` but deferred until a forcing case surfaces.
export const correctors: Record<string, CorrectorFn> = { math, dates, currency, citations };

// Names that have already warned this process. Prevents repeated noise
// when a run loops or when tests re-register.
const warnedOverrides = new Set<string>();

/**
 * Merge app-supplied correctors into the registry. App-level names win
 * on collision (intentional override hook, mirrors the RED-209 plugin-
 * tool precedence rule). Logs a single stderr warning per overridden
 * name per process.
 */
export function registerAppCorrectors(extras: Record<string, CorrectorFn>): void {
  for (const [name, fn] of Object.entries(extras)) {
    if (name in correctors && !warnedOverrides.has(name)) {
      warnedOverrides.add(name);
      console.error(
        `[cambium] app corrector "${name}" overrides the framework built-in`,
      );
    }
    correctors[name] = fn;
  }
}

/**
 * Clear registered app correctors and reset the override-warning set.
 * Test-only — the CLI is one-shot so there's no production caller.
 */
export function _resetAppCorrectorsForTests(builtinNames: string[]): void {
  for (const name of Object.keys(correctors)) {
    if (!builtinNames.includes(name)) delete correctors[name];
  }
  warnedOverrides.clear();
}

export function runCorrectorPipeline(
  names: string[],
  data: any,
  context: { document?: string },
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
