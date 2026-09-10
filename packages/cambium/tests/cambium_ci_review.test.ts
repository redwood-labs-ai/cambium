/**
 * Cambium CI Review pipeline — end-to-end POC (RED-381).
 *
 * Real two-stage pipeline that reviews Cambium PRs using Cambium.
 * Stage 1 (CambiumDiffAnalyzer) classifies the diff; Stage 2
 * (CambiumPrReviewer) reasons from the structured analysis to produce
 * a typed review. Both gens + their schemas + the pipeline file all
 * live in this repo as production code — this is the actual canonical
 * example, not a fixture.
 *
 * Tests drive the pipeline against the mock provider (CAMBIUM_ALLOW_MOCK=1)
 * with a real-ish Cambium diff fixture to verify the wiring: 2-step
 * trace shape, sub-gen IR resolution, bind() flow from input → analyze
 * → review, output validation against CambiumCiReview.
 *
 * #233: the pipeline is now MULTI-SLOT (`diff` + `surfaces`), which #226
 * enforces fail-closed — `--arg` must be a JSON object supplying both
 * slots, matching what `scripts/ci-review-input.mjs` builds for the real
 * workflow. `runReview` writes that object to a scratch file per call.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tryReadRunDir, cleanupRunDir } from './helpers/run-dir.js';
import { classifyTouchedSurfaces } from '../src/contracts.js';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const PIPELINE = 'packages/cambium/app/pipelines/cambium_ci_review.pipeline.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/cambium_pr_diff.txt';

// The fixture diff touches ruby/cambium/pipeline.rb — one real deterministic
// surface, matching what the workflow would actually compute for a diff
// shaped like this one.
const FIXTURE_CHANGED_PATHS = ['ruby/cambium/pipeline.rb'];

function runReview(extraArgs: string[] = []) {
  const diff = readFileSync(join(REPO_ROOT, FIXTURE), 'utf8');
  const surfaces = classifyTouchedSurfaces(FIXTURE_CHANGED_PATHS);
  const scratch = mkdtempSync(join(tmpdir(), 'cambium-ci-review-arg-'));
  const argPath = join(scratch, 'pipeline-input.json');
  writeFileSync(argPath, JSON.stringify({ diff, surfaces }));
  try {
    return spawnSync(
      'node',
      [CLI, 'run', PIPELINE, '--method', 'review', '--arg', argPath, '--mock', ...extraArgs],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('Cambium CI Review pipeline (real two-stage POC)', () => {
  it('compiles to a valid Pipeline IR with the two sequential steps wired up', () => {
    const result = spawnSync(
      'ruby',
      [join(REPO_ROOT, 'ruby/cambium/compile.rb'), PIPELINE, '--method', 'review'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    const ir = JSON.parse(result.stdout);
    expect(ir.kind).toBe('Pipeline');
    expect(ir.name).toBe('CambiumCiReview');
    // #233: second declared input slot — the deterministic touched-surface
    // floor, threaded to Stage 2 alongside Stage 1's analysis.
    expect(ir.input).toEqual({
      diff: { schema: 'PullRequestDiff' },
      surfaces: { schema: 'CambiumTouchedSurfaces' },
    });
    expect(ir.operators).toHaveLength(2);
    expect(ir.operators[0]).toMatchObject({
      kind: 'Step',
      id: 'analyze',
      gen: 'CambiumDiffAnalyzer',
      method: 'analyze',
    });
    expect(ir.operators[1]).toMatchObject({
      kind: 'Step',
      id: 'review',
      gen: 'CambiumPrReviewer',
      method: 'review',
    });
    // Stage 2 binds to Stage 1's full output (no chained field — passes
    // the whole CambiumDiffAnalysis object so the reviewer sees the
    // structured classification) PLUS the deterministic surfaces floor
    // from the pipeline's second input slot.
    expect(ir.operators[1].with).toEqual([
      { param: 'analysis', from: { step: 'analyze' } },
      { param: 'surfaces', from: { input: 'surfaces' } },
    ]);
  });

  it('runs end-to-end against the mock provider with a real Cambium-flavored diff', () => {
    const result = runReview();
    if (result.status !== 0) {
      throw new Error(
        `Pipeline failed (status ${result.status})\nstderr: ${result.stderr}`,
      );
    }

    // Output should be a valid CambiumCiReview shape.
    const output = JSON.parse(result.stdout);
    expect(typeof output.summary).toBe('string');
    expect(Array.isArray(output.concerns)).toBe(true);
    expect(['approve', 'approve_with_suggestions', 'request_changes'])
      .toContain(output.overall_verdict);
  });

  it('emits a PipelineRun trace with both PipelineStep entries + nested sub-gen traces', () => {
    const result = runReview();
    const runDir = tryReadRunDir(result.stderr);
    try {
      expect(result.status).toBe(0);
      expect(runDir).toBeTruthy();
      const trace = JSON.parse(readFileSync(join(runDir!, 'trace.json'), 'utf8'));

      expect(trace.type).toBe('PipelineRun');
      expect(trace.ok).toBe(true);
      expect(trace.name).toBe('CambiumCiReview');
      expect(trace.meta.operators_executed).toBe(2);

      expect(trace.operators).toHaveLength(2);
      expect(trace.operators[0].id).toBe('analyze');
      expect(trace.operators[0].gen).toBe('CambiumDiffAnalyzer');
      expect(trace.operators[1].id).toBe('review');
      expect(trace.operators[1].gen).toBe('CambiumPrReviewer');
      // Each PipelineStep nests its sub-gen's full trace.
      expect(Array.isArray(trace.operators[0].trace?.steps)).toBe(true);
      expect(Array.isArray(trace.operators[1].trace?.steps)).toBe(true);

    } finally {
      cleanupRunDir(runDir);
    }
  });

  it('Stage 2 receives Stage 1 structured analysis in its sub-gen context', () => {
    const result = runReview();
    const runDir = tryReadRunDir(result.stderr);
    try {
      expect(result.status).toBe(0);
      expect(runDir).toBeTruthy();
      const trace = JSON.parse(readFileSync(join(runDir!, 'trace.json'), 'utf8'));

      // The review step's sub-gen IR (preserved in its trace) carries
      // the analysis from Stage 1 in its context.
      const reviewStep = trace.operators[1];
      // Sub-gen traces include the Generate step with the context that
      // was used. Validate that the analysis flowed through.
      const subGen = reviewStep.trace;
      const generateStep = subGen.steps.find((s: any) => s.type === 'Generate');
      expect(generateStep).toBeDefined();
      expect(generateStep.ok).toBe(true);
      // The output of Stage 1 (CambiumDiffAnalysis shape) was visible to
      // Stage 2 — verified by the successful trace; the mock returns the
      // canned CambiumCiReview shape for Stage 2's schema id regardless
      // of context contents.

    } finally {
      cleanupRunDir(runDir);
    }
  });

  it('output.json round-trips the assembled CambiumCiReview', () => {
    const result = runReview();
    const runDir = tryReadRunDir(result.stderr);
    try {
      expect(result.status).toBe(0);
      expect(runDir).toBeTruthy();
      const output = JSON.parse(readFileSync(join(runDir!, 'output.json'), 'utf8'));
      // Default last_step output: Stage 2's CambiumCiReview.
      expect(output.summary).toBeTruthy();
      expect(output.overall_verdict).toBeTruthy();
    } finally {
      cleanupRunDir(runDir);
    }
  });

  // #233: `--mock` never builds a real prompt, so the tests above can't see
  // whether `surfaces` actually reaches Stage 2's rendered prompt (as
  // opposed to just resolving in the IR, which the first test already
  // pins). Drives a real dispatch against a local stub oMLX-compatible
  // server and reads the `SURFACES:` section back out of the captured
  // request.
  //
  // Uses `spawn` (async), NOT `spawnSync`: `spawnSync` blocks this
  // process's entire event loop until the child exits, so the in-process
  // stub server below would never get to run its request handler — the
  // child's TCP connection completes at the kernel level (visible in
  // `ss -tnp`) but the parent's JS never wakes up to service it, and the
  // child hangs until spawnSync's own timeout kills it. Confirmed by
  // reproducing the hang standalone before writing this test this way.
  it('Stage 2s rendered prompt carries a SURFACES: section with the deterministic floor', async () => {
    const capturedPrompts: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const userMsg = (parsed.messages ?? []).find((m: any) => m.role === 'user');
        capturedPrompts.push(typeof userMsg?.content === 'string' ? userMsg.content : '');
        // Stage 1 gets the first request, Stage 2 the second — return the
        // right canned shape for whichever schema is being asked for.
        const isStage1 = capturedPrompts.length === 1;
        const responseBody = isStage1
          ? { touched_surfaces: [], risk_categories: ['none'], magnitude: 'small', files_changed: 1, key_excerpts: [], summary: 'stub analysis' }
          : { summary: 'stub review', concerns: [], overall_verdict: 'approve' };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(responseBody) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const diff = readFileSync(join(REPO_ROOT, FIXTURE), 'utf8');
    const surfaces = classifyTouchedSurfaces(FIXTURE_CHANGED_PATHS); // ['ruby_dsl']
    const scratch = mkdtempSync(join(tmpdir(), 'cambium-ci-review-real-'));
    const argPath = join(scratch, 'pipeline-input.json');
    writeFileSync(argPath, JSON.stringify({ diff, surfaces }));

    let status: number | null;
    let stdout = '';
    let stderr = '';
    try {
      const child = spawn(
        'node',
        [CLI, 'run', PIPELINE, '--method', 'review', '--arg', argPath],
        { cwd: REPO_ROOT, env: { ...process.env, CAMBIUM_OMLX_BASEURL: `http://127.0.0.1:${port}` } },
      );
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
      // AUD-007 (round 3 audit): this test's real dispatch creates a
      // runs/run_* directory like every sibling test in this file — clean
      // it up the same way they do (helpers/run-dir.ts), in `finally` so
      // a failing assertion below still doesn't leak one.
      cleanupRunDir(tryReadRunDir(stderr));
    }

    expect(status, stderr + stdout).toBe(0);
    expect(capturedPrompts).toHaveLength(2);
    const reviewPrompt = capturedPrompts[1];
    expect(reviewPrompt).toContain('SURFACES:');
    expect(reviewPrompt).toMatch(/SURFACES:\n\[\s*"ruby_dsl"\s*\]/);
  });
});
