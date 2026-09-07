/**
 * RED-223: end-to-end smoke of `cambium run --mock` for every
 * in-tree gen, agentic and non-agentic.
 *
 * The two bugs fixed on RED-221 (a missing optional chain and an
 * un-awaited Promise, both in runner.ts's main() orchestration) lived
 * in code paths that no unit test touched. The fix for that class of
 * bug is to shell out to the actual CLI with --mock and check the run
 * completes cleanly — direct-call tests can't catch errors in the
 * orchestration layer above the module boundary.
 *
 * RED-375: agentic gens (`mode :agentic`) used to silently hit the
 * real provider under --mock because `generateWithTools` had no
 * CAMBIUM_ALLOW_MOCK gate. Now they're in the matrix below — they must
 * complete offline with the mock generator returning one turn of text
 * and zero tool_calls (terminates the agentic loop after one turn).
 *
 * #205: the mock is schema-derived (`mock-output.ts`), so every gen in
 * the matrix now gets a candidate shaped like ITS OWN `returns` schema,
 * not the analyst-shaped stub. `requiredOutputKeys` is therefore valid
 * for any gen; the two #205 rows (theme_palette, notes_summarizer) also
 * have full goldens in `theme_palette.test.ts` / `notes_summarizer.test.ts`
 * — this matrix only proves the orchestration completes.
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
  /** When set, assert these keys exist on the output. Since #205 the
   *  mock is derived from the gen's own schema, so any declared
   *  required key is fair to assert. */
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
    name: 'log_summarizer (distinct schema — pre-#205 the analyst-shaped mock failed validation here)',
    gen: 'packages/cambium/app/gens/log_summarizer.cmb.rb',
    method: 'summarize',
    fixture: 'packages/cambium/examples/fixtures/incident_with_logs.txt',
    // #205: the mock is now derived from LogSummary, so its top-level
    // key is present. The value of this row is still that the
    // orchestration (compile + run + validate + repair + grounding +
    // signals + triggers + trace-write) completes without crashing,
    // not that the mock output is semantically correct.
    requiredOutputKeys: ['key_events'],
  },
  {
    // RED-375: agentic gen under --mock must terminate offline (no
    // provider). Pre-fix, generateWithTools had no mock gate and this
    // call hit the real Ollama server (or hard-errored on missing
    // ANTHROPIC_API_KEY). data_analyst returns AnalysisReport which
    // matches mockGenerate's analyst stub, so the output shape can
    // also be asserted.
    name: 'data_analyst (mode :agentic — RED-375 mock gate)',
    gen: 'packages/cambium/app/gens/data_analyst.cmb.rb',
    method: 'analyze',
    fixture: 'packages/cambium/examples/fixtures/incident.txt',
    requiredOutputKeys: ['summary'],
  },
  {
    // #205: 26-key `returns do … end` block with an enum — the case that
    // motivated schema-derived mock output (pre-#205: 26 missing
    // required fields, exit 1 on every --mock run).
    name: 'theme_palette (#205 — 26-key inline returns block, enum-first mode)',
    gen: 'packages/cambium/app/gens/theme_palette.cmb.rb',
    method: 'generate_palette',
    fixture: 'packages/cambium/examples/fixtures/omarchy_swatches.json',
    requiredOutputKeys: ['mode', 'accent', 'background', 'foreground'],
  },
  {
    // #205 + #169: nested array-of-objects under a grounded_in with an
    // inferred markdown format.
    name: 'notes_summarizer (#205 — nested arrays; #169 inferred markdown grounding)',
    gen: 'packages/cambium/app/gens/notes_summarizer.cmb.rb',
    method: 'summarize',
    fixture: 'packages/cambium/examples/fixtures/release_notes.md',
    requiredOutputKeys: ['summary', 'highlights'],
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
