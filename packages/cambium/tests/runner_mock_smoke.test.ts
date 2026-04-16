/**
 * RED-223: end-to-end smoke of `cambium run --mock` for every
 * non-agentic in-tree gen.
 *
 * The two bugs fixed on RED-221 (a missing optional chain and an
 * un-awaited Promise, both in runner.ts's main() orchestration) lived
 * in code paths that no unit test touched. The fix for that class of
 * bug is to shell out to the actual CLI with --mock and check the run
 * completes cleanly — direct-call tests can't catch errors in the
 * orchestration layer above the module boundary.
 *
 * Agentic gens (gaia_solver, web_researcher, data_analyst) are skipped
 * here because `generateWithTools` has no mock fallback today; adding
 * one is a separate concern.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Case = {
  name: string;
  gen: string;
  method: string;
  fixture: string;
  /** When set, assert these keys exist on the output. Only valid for
   *  gens whose schema matches mockGenerate's analyst-shaped stub. */
  requiredOutputKeys?: string[];
};

const CASES: Case[] = [
  {
    name: 'analyst (correctors + grounding + signals + triggers)',
    gen: 'packages/cambium/app/gens/analyst.cmb.rb',
    method: 'analyze',
    fixture: 'packages/cambium/examples/fixtures/incident.txt',
    requiredOutputKeys: ['summary', 'metrics'],
  },
  {
    name: 'analyst_enriched (enrichment path)',
    gen: 'packages/cambium/app/gens/analyst_enriched.cmb.rb',
    method: 'analyze',
    fixture: 'packages/cambium/examples/fixtures/incident.txt',
    requiredOutputKeys: ['summary'],
  },
  {
    name: 'analyst_repair (repair policy)',
    gen: 'packages/cambium/app/gens/analyst_repair.cmb.rb',
    method: 'analyze',
    fixture: 'packages/cambium/examples/fixtures/incident.txt',
    requiredOutputKeys: ['summary'],
  },
  {
    name: 'log_summarizer (distinct schema — mock output won\'t pass validation but orchestration must complete)',
    gen: 'packages/cambium/app/gens/log_summarizer.cmb.rb',
    method: 'summarize',
    fixture: 'packages/cambium/examples/fixtures/incident_with_logs.txt',
    // No requiredOutputKeys — mockGenerate produces analyst-shaped
    // output which doesn't match LogSummary. The value of this test
    // is that the orchestration (compile + run + validate + repair +
    // grounding + signals + triggers + trace-write) completes without
    // crashing, not that the mock output is semantically correct.
  },
];

describe('runner mock smoke — non-agentic gens run clean end-to-end', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const tmp = mkdtempSync(join(tmpdir(), 'cambium-mock-'));
      const tracePath = join(tmp, 'trace.json');
      const outPath = join(tmp, 'output.json');

      // Invoke the CLI exactly the way a user would. This exercises
      // compile + runner + main() orchestration end-to-end.
      const result = spawnSync(
        'node',
        [
          'cli/cambium.mjs',
          'run',
          c.gen,
          '--method', c.method,
          '--arg', c.fixture,
          '--trace', tracePath,
          '--out', outPath,
          '--mock',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CAMBIUM_ALLOW_MOCK: '1' },
          cwd: process.cwd(),
        },
      );

      // The runner completes without crashing. Exit 0 = success; exit
      // 1 = validation/repair failure (expected when mockGenerate's
      // output doesn't match the gen's schema). Any other exit code
      // (signal kill, unhandled exception) is a real failure.
      expect(
        [0, 1].includes(result.status ?? -1),
        `Unexpected exit code ${result.status}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
      ).toBe(true);

      // Trace file exists and is valid JSON — catches trace-step
      // construction bugs.
      expect(existsSync(tracePath)).toBe(true);
      const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
      expect(Array.isArray(trace.steps)).toBe(true);
      expect(trace.steps.length).toBeGreaterThan(0);

      // Output file exists and is valid JSON (even if the mock output
      // didn't pass schema validation — that's a mock-shape limitation,
      // not an orchestration crash).
      expect(existsSync(outPath)).toBe(true);
      const output = JSON.parse(readFileSync(outPath, 'utf8'));

      // For gens whose schema matches mockGenerate's analyst stub,
      // also check the output shape.
      if (c.requiredOutputKeys) {
        for (const k of c.requiredOutputKeys) {
          expect(output, `output missing key '${k}': ${JSON.stringify(output).slice(0, 200)}`)
            .toHaveProperty(k);
        }
      }
    }, 30_000); // 30s timeout — compile + runner startup is ~1-2s per gen
  }
});
