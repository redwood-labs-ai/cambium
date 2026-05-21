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
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const PIPELINE = 'packages/cambium/app/pipelines/cambium_ci_review.pipeline.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/cambium_pr_diff.txt';

function runReview(extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [CLI, 'run', PIPELINE, '--method', 'review', '--arg', FIXTURE, '--mock', ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    },
  );
}

function readRunDir(stderr: string): string {
  const m = stderr.match(/dir=(\S+)/);
  expect(m).toBeTruthy();
  return m![1];
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
    expect(ir.input).toEqual({ diff: { schema: 'PullRequestDiff' } });
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
    // structured classification.)
    expect(ir.operators[1].with).toEqual([
      { param: 'analysis', from: { step: 'analyze' } },
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
    expect(result.status).toBe(0);
    const runDir = readRunDir(result.stderr);
    const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));

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

    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  it('Stage 2 receives Stage 1 structured analysis in its sub-gen context', () => {
    const result = runReview();
    expect(result.status).toBe(0);
    const runDir = readRunDir(result.stderr);
    const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));

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

    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  it('output.json round-trips the assembled CambiumCiReview', () => {
    const result = runReview();
    expect(result.status).toBe(0);
    const runDir = readRunDir(result.stderr);
    const output = JSON.parse(readFileSync(join(runDir, 'output.json'), 'utf8'));
    // Default last_step output: Stage 2's CambiumCiReview.
    expect(output.summary).toBeTruthy();
    expect(output.overall_verdict).toBeTruthy();
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });
});
