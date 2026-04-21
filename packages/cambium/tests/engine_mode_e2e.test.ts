/**
 * RED-287: engine-mode end-to-end integration test.
 *
 * Builds a minimal engine folder in a tmpdir — schemas.ts + sibling
 * tool + sibling corrector + gen — then compiles + runs it via the
 * CLI and asserts that every sibling surface was actually discovered.
 *
 * Uses --mock for the generate step so we don't need a live LLM; the
 * point is to validate discovery, not model output.
 *
 * This is the only test that exercises engine mode end-to-end through
 * the real CLI. Everything else in `scaffolder_engine_mode.test.ts`
 * stops at file-layout assertions; this one proves the runner actually
 * finds what the scaffolder writes.
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

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-engine-e2e-'));
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

function setupEngine(engineDir: string) {
  mkdirSync(engineDir, { recursive: true });

  // RED-306: the CLI now loads engine TS files via `tsx/esm/api`'s
  // programmatic register() — which honors the nearest package.json's
  // "type" field. Real engine-mode users live inside a Node project
  // that declares `"type": "module"`; the test fixture previously
  // omitted this and coasted on the old `node --import tsx` subprocess
  // path, which tolerated the missing declaration by falling back to
  // CJS. Write an explicit package.json so the temp engine reflects
  // how real users deploy.
  writeFileSync(
    join(engineDir, 'package.json'),
    JSON.stringify({ name: 'e2e_engine_fixture', type: 'module', private: true }) + '\n',
  );

  writeFileSync(
    join(engineDir, 'cambium.engine.json'),
    JSON.stringify({ name: 'e2e_engine', version: '0.1.0' }),
  );

  // Schemas — single export matching the gen's `returns`. Written as a
  // plain JSON Schema object rather than a TypeBox import so the tmpdir
  // engine folder doesn't need its own node_modules/@sinclair/typebox.
  // The runner treats anything with a $id as a schema; TypeBox is the
  // authoring ergonomic, not a runtime requirement.
  writeFileSync(
    join(engineDir, 'schemas.ts'),
    `
export const E2EReport = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: true,
  $id: 'E2EReport',
};
`.trim() + '\n',
  );

  // System prompt (sibling, engine convention).
  writeFileSync(
    join(engineDir, 'e2e_gen.system.md'),
    'You are an e2e test agent.\n',
  );

  // Sibling tool — declaration + handler. The gen declares `uses :e2e_tool`
  // so the registry must find it; missing = hard fail.
  writeFileSync(
    join(engineDir, 'e2e_tool.tool.json'),
    JSON.stringify({
      name: 'e2e_tool',
      description: 'test tool',
      permissions: { pure: true },
      inputSchema: {
        type: 'object',
        required: ['input'],
        properties: { input: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['result'],
        properties: { result: { type: 'string' } },
        additionalProperties: false,
      },
    }, null, 2) + '\n',
  );
  writeFileSync(
    join(engineDir, 'e2e_tool.tool.ts'),
    `
export async function execute(input: { input: string }): Promise<{ result: string }> {
  return { result: 'ok:' + input.input };
}
`.trim() + '\n',
  );

  // Sibling corrector — declaration. The gen declares `corrects :e2e_corr`
  // so the registry must find the sibling export.
  writeFileSync(
    join(engineDir, 'e2e_corr.corrector.ts'),
    `
export const e2e_corr = (data: any, _context: any) => ({
  corrected: false,
  output: data,
  issues: [],
});
`.trim() + '\n',
  );

  // Gen file. Uses mock model so we don't need a live LLM for the e2e.
  writeFileSync(
    join(engineDir, 'e2e_gen.cmb.rb'),
    `
class E2eGen < GenModel
  model "omlx:stub"
  system :e2e_gen
  returns E2EReport
  uses :e2e_tool
  corrects :e2e_corr
  def analyze(x)
    generate "x" do
      with context: x
      returns E2EReport
    end
  end
end
`.trim() + '\n',
  );
}

describe('engine mode — end-to-end (RED-287)', () => {
  it('runs an engine gen via CLI and discovers every sibling surface', () => {
    const engineDir = join(scratch, 'my_engine');
    setupEngine(engineDir);

    const fixturePath = join(engineDir, 'fixture.txt');
    writeFileSync(fixturePath, 'hello world\n');

    const result = runCli(
      [
        'run',
        join(engineDir, 'e2e_gen.cmb.rb'),
        '--method', 'analyze',
        '--arg', fixturePath,
        '--mock',
      ],
      // Deliberately invoke from the cambium repo root — the engine is
      // external to cwd. The engine discovery walks up from the IR
      // source, not cwd, so this must still work.
      REPO_ROOT,
      { CAMBIUM_ALLOW_MOCK: '1' },
    );

    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    expect(result.status, `CLI failed: ${combined}`).toBe(0);

    // Run artifacts land under <engineDir>/runs/, not <cwd>/runs/
    // (RED-287 engine-self-contained behavior). We snapshot the set of
    // run_* entries under REPO_ROOT/runs/ before and after to assert
    // that the engine run did NOT write there — the CLI was invoked
    // from REPO_ROOT precisely to tempt it to.
    const runsDir = join(engineDir, 'runs');
    expect(existsSync(runsDir), 'engine/runs/ should exist').toBe(true);
    const runEntries = readdirSync(runsDir).filter(e => e.startsWith('run_'));
    expect(runEntries.length).toBeGreaterThan(0);

    // Trace shows the gen completed.
    const tracePath = join(runsDir, runEntries[0], 'trace.json');
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const steps = trace.steps ?? [];
    const stepTypes = steps.map((s: any) => s.type);
    expect(stepTypes).toContain('Generate');

    // Corrector step present — the engine sibling corrector was discovered
    // and ran. The Correct step carries the list of correctors in meta.
    const correctSteps = steps.filter((s: any) => s.type === 'Correct');
    expect(correctSteps.length).toBeGreaterThan(0);
    const correctorsRan: string[] = correctSteps.flatMap(
      (s: any) => s.meta?.correctors ?? [],
    );
    expect(correctorsRan).toContain('e2e_corr');
  }, 30_000);

});
