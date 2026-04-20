/**
 * RED-289: engine-mode end-to-end against a live LLM.
 *
 * Opt-in — skipped unless `CAMBIUM_LIVE_TESTS=1` is set. Catches
 * drift in real-model response handling (schema prompting, extra-
 * fields behavior, repair-loop interactions) that the mock path in
 * engine_mode_e2e.test.ts trivially passes.
 *
 * The live test uses whatever oMLX server the project is configured
 * against (`CAMBIUM_OMLX_BASEURL` default: `http://100.114.183.54:8080`).
 * If `CAMBIUM_LIVE_TESTS=1` is set but the server is unreachable, the
 * test will fail with a spawn error — intentional; the opt-in means
 * "I've verified I have a live backend." Don't silently skip when the
 * backend is down, or a local breakage goes undetected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

const LIVE = process.env.CAMBIUM_LIVE_TESTS === '1';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-engine-live-e2e-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe.runIf(LIVE)('engine mode — live LLM end-to-end (RED-289)', () => {
  it('compiles + runs an engine against a live oMLX model and returns a validated output', () => {
    const engineDir = join(scratch, 'live_engine');
    mkdirSync(engineDir, { recursive: true });

    writeFileSync(
      join(engineDir, 'cambium.engine.json'),
      JSON.stringify({ name: 'live_engine', version: '0.1.0' }),
    );

    // Loose schema — allow extra fields so a chatty model doesn't fail
    // validation, but require at least `summary` as a non-empty string.
    writeFileSync(
      join(engineDir, 'schemas.ts'),
      `
export const LiveReport = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1 },
  },
  required: ['summary'],
  additionalProperties: true,
  $id: 'LiveReport',
};
`.trim() + '\n',
    );

    writeFileSync(
      join(engineDir, 'live_gen.system.md'),
      'You summarize a short document in one sentence. Return JSON with a `summary` field.\n',
    );

    // Pick a small/fast model the oMLX server is likely to have loaded.
    // If the default doesn't match the operator's server, override via
    // CAMBIUM_LIVE_MODEL in the test env.
    const model = process.env.CAMBIUM_LIVE_MODEL ?? 'omlx:gemma-4-31b-it-8bit';
    writeFileSync(
      join(engineDir, 'live_gen.cmb.rb'),
      `
class LiveGen < GenModel
  model "${model}"
  system :live_gen
  returns LiveReport
  def analyze(x)
    generate "Summarize this document in one sentence." do
      with context: x
      returns LiveReport
    end
  end
end
`.trim() + '\n',
    );

    const fixturePath = join(engineDir, 'fixture.txt');
    writeFileSync(
      fixturePath,
      'The quick brown fox jumps over the lazy dog. This is a short test document used to verify engine-mode end-to-end behavior against a live model.\n',
    );

    const result = runCli(
      [
        'run',
        join(engineDir, 'live_gen.cmb.rb'),
        '--method', 'analyze',
        '--arg', fixturePath,
      ],
      REPO_ROOT,
    );

    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    expect(result.status, `CLI failed: ${combined}`).toBe(0);

    // Runs landed under <engineDir>/runs/ — engine self-containment
    // invariant from the mock e2e test holds against live too.
    const runsDir = join(engineDir, 'runs');
    expect(existsSync(runsDir)).toBe(true);
    const runEntries = readdirSync(runsDir).filter(e => e.startsWith('run_'));
    expect(runEntries.length).toBeGreaterThan(0);

    // Output validated — summary is a non-empty string.
    const outputPath = join(runsDir, runEntries[0], 'output.json');
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(typeof output.summary).toBe('string');
    expect(output.summary.length).toBeGreaterThan(0);

    // Trace shows a real generation — not the deterministic mock text.
    const trace = JSON.parse(readFileSync(join(runsDir, runEntries[0], 'trace.json'), 'utf8'));
    const generateStep = (trace.steps ?? []).find((s: any) => s.type === 'Generate');
    expect(generateStep).toBeTruthy();
    // Guard against the mock creeping in silently (signature of the
    // deterministic mock is the literal "Mock analysis (model provider
    // not available)." string).
    expect(generateStep.meta?.raw_preview ?? '').not.toMatch(/Mock analysis/);
  }, 120_000);
});
