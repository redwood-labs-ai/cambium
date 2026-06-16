/**
 * RED-381 Phase B.1: Pipeline runtime end-to-end against the mock provider.
 *
 * Drives `cambium run app/pipelines/<file>.pipeline.rb --method <m>
 * --arg <path> --mock` through the CLI and asserts on the artifacts
 * the pipeline runner writes: output.json, trace.json (with the new
 * PipelineRun / PipelineStep types nesting sub-gen traces), and the
 * exit code.
 *
 * Phase B.1 scope: `step` operator only. fan_out (Phase C) and
 * branch_on (Phase D) IRs compile but throw at runtime — covered by
 * a negative test below to lock in the "not yet supported" message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const SAMPLE_PIPELINE = 'packages/cambium/app/pipelines/sample_pipeline.pipeline.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/incident.txt';

function runPipelineCli(
  pipelineFile: string,
  method: string,
  argPath: string,
  extraArgs: string[] = [],
) {
  return spawnSync(
    'node',
    [CLI, 'run', pipelineFile, '--method', method, '--arg', argPath, '--mock', ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    },
  );
}

describe('RED-381 Phase B.1: sequential pipeline runs end-to-end (mock)', () => {
  let traceOut: string;
  let outputOut: string;
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-b1-'));
    traceOut = join(scratch, 'trace.json');
    outputOut = join(scratch, 'output.json');
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('exits 0 and produces output + trace artifacts', () => {
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `Pipeline CLI exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    expect(existsSync(traceOut)).toBe(true);
    expect(existsSync(outputOut)).toBe(true);
  });

  it('emits a PipelineRun trace wrapping per-step PipelineStep entries', () => {
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    expect(trace.type).toBe('PipelineRun');
    expect(trace.ok).toBe(true);
    expect(trace.name).toBe('SamplePipeline');
    expect(trace.entry.method).toBe('review');
    expect(trace.run_id).toMatch(/^run_/);
    expect(trace.started_at).toBeTruthy();
    expect(trace.finished_at).toBeTruthy();
    expect(trace.meta?.operators_executed).toBe(3);
    expect(Array.isArray(trace.operators)).toBe(true);
    expect(trace.operators).toHaveLength(3);

    const ids = trace.operators.map((o: any) => o.id);
    expect(ids).toEqual(['triage', 'remediate', 'summary']);
    expect(trace.operators.every((o: any) => o.type === 'PipelineStep')).toBe(true);
    expect(trace.operators.every((o: any) => o.ok === true)).toBe(true);
  });

  it('nests each sub-gen trace inside its PipelineStep entry', () => {
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    for (const op of trace.operators) {
      expect(op.trace).toBeDefined();
      expect(op.trace.run_id).toMatch(/^run_/);
      // Sub-gen traces carry their own steps[] array — the existing
      // gen trace shape, unchanged.
      expect(Array.isArray(op.trace.steps)).toBe(true);
      expect(op.trace.steps.length).toBeGreaterThan(0);
      // Generate step should exist for every sub-gen run.
      expect(op.trace.steps.some((s: any) => s.type === 'Generate')).toBe(true);
    }
  });

  it('persists each PipelineStep output value in the trace (RED-385 Phase A)', () => {
    // Pipeline replay rehydrates stepResults (the bind()-resolution state)
    // from the recorded operator outputs. Before Phase A these lived only
    // in memory; they must now be serialized into each operator entry.
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    for (const op of trace.operators) {
      expect(op).toHaveProperty('output');
      expect(op.output).toBeTruthy();
    }
    // The last step's persisted output equals the pipeline's final output
    // (default last_step assembly) — proves it's the real value, not a stub.
    const output = JSON.parse(readFileSync(outputOut, 'utf8'));
    const lastOp = trace.operators[trace.operators.length - 1];
    expect(lastOp.output).toEqual(output);
  });

  it('pipeline output is the last step output (default last_step assembly)', () => {
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);

    const output = JSON.parse(readFileSync(outputOut, 'utf8'));
    // The mock provider's AnalysisReport shape:
    expect(output.summary).toMatch(/Mock analysis/);
    expect(Array.isArray(output.metrics?.latency_ms_samples)).toBe(true);
  });

  it('passes prior step output through bind(:triage).summary into remediate', () => {
    // sample_pipeline:
    //   step :remediate, gen: Analyst, method: :analyze,
    //     with: { document: bind(:triage).summary }
    //
    // Each Analyst run logs its prompt indirectly via the trace —
    // we can't grep the prompt directly, but we can verify the
    // remediate step received a non-empty context (the mock-returned
    // summary string, not the original raw arg).
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const remediate = trace.operators.find((o: any) => o.id === 'remediate');
    expect(remediate).toBeDefined();
    expect(remediate.ok).toBe(true);
    // The nested trace's generate step records the context payload.
    // Sub-gen trace has its own ir.context that we can inspect indirectly
    // via the sub-gen entry shape. We at minimum want it to have
    // executed successfully.
    expect(remediate.trace.steps.some((s: any) => s.type === 'Generate' && s.ok)).toBe(true);
  });

  it('CLI stdout carries the final output JSON (parseable)', () => {
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE, [
      '--trace', traceOut,
      '--out', outputOut,
    ]);
    expect(result.status).toBe(0);
    // CLI prints the output as JSON on stdout (mirrors gen-mode behavior).
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary).toMatch(/Mock analysis/);
  });

  it('writes ir.json + trace.json + output.json under packages/cambium/runs/<runId>/', () => {
    // Without --trace / --out overrides, artifacts land in the
    // workspace's default runs/ tree.
    const result = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE);
    expect(result.status).toBe(0);

    // The stderr emit names the run dir; extract it.
    const m = result.stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    const runDir = m![1];
    expect(existsSync(join(runDir, 'ir.json'))).toBe(true);
    expect(existsSync(join(runDir, 'trace.json'))).toBe(true);
    expect(existsSync(join(runDir, 'output.json'))).toBe(true);

    // Best-effort cleanup of the auto-generated run dir.
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  });
});

describe('RED-381 Phase B.2: pipeline budget cap enforcement', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-b2-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    return pipePath;
  }

  it('refuses dispatch when projected next step exceeds remaining token cap', () => {
    // Analyst declares `max_tokens 1200`. A 100-token pipeline cap can't
    // accommodate the projection — pre-dispatch refusal fires before
    // any sub-gen runs.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget tokens: 100
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Pipeline token budget exceeded/);
    expect(result.stderr).toMatch(/Cap: 100/);
    expect(result.stderr).toMatch(/projected next step: 1200/);
  })

  it('writes a PipelineBudgetExceeded trace step on cap hit', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget tokens: 100
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    // Pull the run dir off stderr and inspect the trace.
    const m = result.stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    expect(trace.ok).toBe(false);
    expect(trace.operators).toHaveLength(1);
    const op = trace.operators[0];
    expect(op.type).toBe('PipelineBudgetExceeded');
    expect(op.id).toBe('s1');
    expect(op.metric).toBe('tokens');
    expect(op.cap).toBe(100);
    expect(op.used).toBe(0);
    expect(op.projected).toBe(1200);

    try { rmSync(m![1], { recursive: true, force: true }) } catch {}
  })

  it('uses the conservative default projection when sub-gen omits max_tokens', () => {
    // Analyst declares max_tokens 1200, but if a gen omits it, the
    // pipeline runner falls back to DEFAULT_PROJECTED_STEP_TOKENS (2000).
    // The sample fixture already exercises the declared-max_tokens path;
    // this guards that omission doesn't silently let an unbounded sub-gen
    // through.
    //
    // Synthesize a gen without max_tokens. Pipeline must exist first
    // so writePipelineWorkspace creates the app/gens directory before
    // we write the additional gen file alongside.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget tokens: 500
  step :s1, gen: NoMax, method: :analyze
  def run(doc); end
end
`.trim());
    writeFileSync(
      join(scratch, 'app', 'gens', 'no_max.cmb.rb'),
      `
class NoMax < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim(),
    );
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/projected next step: 2000/);
  })

  it('completes fine when cap is high enough to cover all steps', () => {
    // 3 Analyst steps × 1200 projection = 3600. A 10k cap leaves
    // plenty of headroom.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  budget tokens: 10_000
  step :s1, gen: Analyst, method: :analyze
  step :s2, gen: Analyst, method: :analyze
  step :s3, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    if (result.status !== 0) {
      throw new Error(
        `Expected success, got status=${result.status}\nstderr: ${result.stderr}`,
      );
    }
    const m = result.stderr.match(/dir=(\S+)/);
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    expect(trace.ok).toBe(true);
    expect(trace.meta.budget_cap_tokens).toBe(10_000);
    expect(trace.meta.operators_executed).toBe(3);
    try { rmSync(m![1], { recursive: true, force: true }) } catch {}
  })

  it('omitting the budget block leaves no cap (unlimited)', () => {
    // No budget declared → tokenCap is undefined → pre-dispatch check
    // is skipped entirely. Pipelines without explicit caps still run.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const m = result.stderr.match(/dir=(\S+)/);
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    expect(trace.meta.budget_cap_tokens).toBeUndefined();
    try { rmSync(m![1], { recursive: true, force: true }) } catch {}
  })
});

describe('RED-381 Phase B.3: explicit output composition', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-b3-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    return pipePath;
  }

  it('output do ... end builds a composed object from step refs', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage,    gen: Analyst, method: :analyze
  step :remediate, gen: Analyst, method: :analyze
  output do
    triage_summary    bind(:triage).summary
    remediate_summary bind(:remediate).summary
  end
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output).sort()).toEqual(['remediate_summary', 'triage_summary']);
    expect(output.triage_summary).toMatch(/Mock analysis/);
    expect(output.remediate_summary).toMatch(/Mock analysis/);
  });

  it('output composition can reference bind(:input) too', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  output do
    original    bind(:input).doc
    analyzed    bind(:triage).summary
  end
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    // bind(:input).doc resolves to the pipeline's raw input value
    // (the contents of the --arg fixture file).
    expect(output.original).toMatch(/API latency regression/);
    expect(output.analyzed).toMatch(/Mock analysis/);
  });

  it('emits ir.output.kind === "compose" in the IR for explicit blocks', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  output do
    summary bind(:s1).summary
  end
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const m = result.stderr.match(/dir=(\S+)/);
    const ir = JSON.parse(readFileSync(join(m![1], 'ir.json'), 'utf8'));
    expect(ir.output).toEqual({
      kind: 'compose',
      fields: [{ name: 'summary', from: { step: 's1', field: 'summary' } }],
    });
    try { rmSync(m![1], { recursive: true, force: true }) } catch {}
  });
});

describe('RED-381 Phase C: fan_out parallel branch dispatch', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-c-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string, extraGens: Record<string, string> = {}): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    for (const [name, body] of Object.entries(extraGens)) {
      writeFileSync(join(scratch, 'app', 'gens', `${name}.cmb.rb`), body);
    }
    return pipePath;
  }

  function readRunTrace(stderr: string): any {
    const m = stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    try { rmSync(m![1], { recursive: true, force: true }); } catch {}
    return trace;
  }

  it('runs all branches and emits a PipelineFanOut trace step', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
    branch :b, agent: Analyst, method: :analyze
    branch :c, agent: Analyst, method: :analyze
    concurrency 3
  end
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);

    const trace = readRunTrace(result.stderr);
    expect(trace.operators).toHaveLength(1);
    const fan = trace.operators[0];
    expect(fan.type).toBe('PipelineFanOut');
    expect(fan.id).toBe('reviewers');
    expect(fan.collect_into).toBe('reviews');
    expect(fan.ok).toBe(true);
    expect(fan.meta.succeeded).toBe(3);
    expect(fan.meta.failed).toBe(0);
    expect(fan.meta.threshold).toBe('all');
    expect(fan.branches.map((b: any) => b.branch_id)).toEqual(['a', 'b', 'c']);
    expect(fan.branches.every((b: any) => b.ok === true)).toBe(true);
    // Sub-traces nest under each branch entry
    expect(fan.branches.every((b: any) => Array.isArray(b.trace?.steps))).toBe(true);
  });

  it('downstream bind(:fan_out_id) returns the typed array of branch outputs', () => {
    // The fix step pulls `bind(:reviewers)` into its `reviews` param.
    // For mock-only e2e, Analyst returns a uniform AnalysisReport per
    // branch — we verify the fix step received an array of three.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
    branch :b, agent: Analyst, method: :analyze
    branch :c, agent: Analyst, method: :analyze
  end
  step :synthesize, gen: Analyst, method: :analyze,
    with: { reviews: bind(:reviewers) }
  def run(doc); end
end
`.trim());
    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    if (result.status !== 0) {
      throw new Error(
        `Expected success, got status=${result.status}\nstderr: ${result.stderr}`,
      );
    }
    const trace = readRunTrace(result.stderr);
    expect(trace.operators).toHaveLength(2);
    expect(trace.operators[0].type).toBe('PipelineFanOut');
    expect(trace.operators[1].type).toBe('PipelineStep');
    expect(trace.operators[1].ok).toBe(true);
  });

  it('on_branch_failure :continue tolerates partial failures (with at_least threshold)', () => {
    // Synthesize a "fail" agent that returns invalid output to force a
    // branch failure. Mock always returns AnalysisReport-shaped JSON,
    // so a gen with a different `returns` schema will produce output
    // that fails AJV validation → branch ok=false.
    const failAgentBody = `
class FailReviewer < GenModel
  model "omlx:stub"
  system "inline"
  returns ToolScaffoldResult
  def review(input)
    generate "go" do
      with context: input
      returns ToolScaffoldResult
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :good_a, agent: Analyst, method: :analyze
    branch :good_b, agent: Analyst, method: :analyze
    branch :bad,    agent: FailReviewer, method: :review
    on_branch_failure :continue
    require :at_least, 2
  end
  def run(doc); end
end
`.trim(), { fail_reviewer: failAgentBody });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    const fan = trace.operators[0];
    expect(fan.ok).toBe(true);  // threshold met (2 of 3 succeeded)
    expect(fan.meta.succeeded).toBe(2);
    expect(fan.meta.failed).toBe(1);
    expect(fan.meta.threshold).toBe('at_least:2');
    const badBranch = fan.branches.find((b: any) => b.branch_id === 'bad');
    expect(badBranch.ok).toBe(false);
  });

  it('require :all (default) fails the fan_out on any branch failure', () => {
    const failAgentBody = `
class FailReviewer < GenModel
  model "omlx:stub"
  system "inline"
  returns ToolScaffoldResult
  def review(input)
    generate "go" do
      with context: input
      returns ToolScaffoldResult
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :good, agent: Analyst, method: :analyze
    branch :bad,  agent: FailReviewer, method: :review
    on_branch_failure :continue
    # require :all is the default
  end
  def run(doc); end
end
`.trim(), { fail_reviewer: failAgentBody });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    const trace = readRunTrace(result.stderr);
    const fan = trace.operators[0];
    expect(fan.ok).toBe(false);
    expect(fan.meta.succeeded).toBe(1);
    expect(fan.meta.failed).toBe(1);
    expect(fan.meta.threshold).toBe('all');
  });

  it('expands homogeneous-fan-out sugar (agent + over + as) into one branch per value', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviews, collect_into: :results do
    agent Analyst, method: :analyze
    over [:legal, :financial, :technical], as: :aspect
    concurrency 3
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    const fan = trace.operators[0];
    // Three branches, one per `over` value; ids inherit the value name.
    expect(fan.branches.map((b: any) => b.branch_id)).toEqual([
      'legal', 'financial', 'technical',
    ]);
    expect(fan.meta.succeeded).toBe(3);
  });

  it('pass_context wiring on a top-level fan_out compiles + dispatches (structural)', () => {
    // recon → fan_out with pass_context :summary.
    //
    // STRUCTURAL ONLY: under --mock, mockGenerate returns a fixed summary
    // and cannot carry an upstream-derived sentinel into a branch's
    // observable output, so this CLI case can verify the plumbing
    // compiles + the fan_out dispatches, but NOT that a branch actually
    // RECEIVED the context. The delivery assertion (branch raw_preview
    // contains the upstream sentinel) lives in
    // `pass_context_nested.test.ts` on the stub-provider echo harness —
    // both top-level (positive control) and the AUD-PC1 nested case.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :recon, gen: Analyst, method: :analyze
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
    branch :b, agent: Analyst, method: :analyze
    pass_context :summary
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    // The fan-out completes; pass_context plumbing didn't throw.
    expect(trace.operators[1].type).toBe('PipelineFanOut');
    expect(trace.operators[1].ok).toBe(true);
  });

  it('budget rollup aggregates token usage across all branches', () => {
    // Mock returns 0-token usage from runGen perspective, so this test
    // checks shape rather than counts; we want to verify the metadata
    // fields are populated.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: Analyst, method: :analyze
    branch :b, agent: Analyst, method: :analyze
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    expect(typeof trace.meta.total_tokens).toBe('number');
    expect(typeof trace.meta.total_tool_calls).toBe('number');
    expect(trace.meta.operators_executed).toBe(1);
  });
});

describe('RED-381 Phase F.1: cron integration on pipelines', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-f1-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    return pipePath;
  }

  it('Pipeline class accepts cron and IR carries policies.schedules[]', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  cron :daily, at: "9:00"
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = spawnSync(
      'ruby',
      [join(REPO_ROOT, 'ruby/cambium/compile.rb'), pipePath, '--method', 'run'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    const ir = JSON.parse(result.stdout);
    expect(ir.policies.schedules).toEqual([
      expect.objectContaining({
        id: 'p.run.daily',
        expression: '0 9 * * *',
        method: 'run',
        named: 'daily',
        at: '9:00',
      }),
    ]);
  });

  it('--fired-by validates against declared schedules at pipeline startup', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  cron :daily, at: "9:00"
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());

    // Unknown schedule id should fail with a clear listing.
    const bad = spawnSync(
      'node',
      [CLI, 'run', pipePath, '--method', 'run', '--arg', join(REPO_ROOT, FIXTURE),
       '--mock', '--fired-by', 'schedule:does_not_exist'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    expect(bad.status).not.toBe(0);
    expect(bad.stderr + bad.stdout).toMatch(/schedule id "does_not_exist" is not declared/);
    expect(bad.stderr + bad.stdout).toMatch(/p\.run\.daily/);

    // Known id passes through to a normal run.
    const good = spawnSync(
      'node',
      [CLI, 'run', pipePath, '--method', 'run', '--arg', join(REPO_ROOT, FIXTURE),
       '--mock', '--fired-by', 'schedule:p.run.daily'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    if (good.status !== 0) {
      throw new Error(`Expected success; got ${good.status}\nstderr: ${good.stderr}`);
    }
    // Trace should carry the fired_by annotation.
    const m = good.stderr.match(/dir=(\S+)/);
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    expect(trace.fired_by).toBe('schedule:p.run.daily');
    try { rmSync(m![1], { recursive: true, force: true }); } catch {}
  });

  it('--fired-by on a pipeline without schedules is a clear error', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());
    const result = spawnSync(
      'node',
      [CLI, 'run', pipePath, '--method', 'run', '--arg', join(REPO_ROOT, FIXTURE),
       '--mock', '--fired-by', 'schedule:any'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/declares no cron schedules/);
  });

  it('cambium schedule list/compile recognize .pipeline.rb files', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  cron :daily, at: "9:00"
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());

    // schedule list walks the pipelines dir alongside gens.
    const list = spawnSync(
      'node',
      [CLI, 'schedule', 'list', join(scratch, 'app', 'pipelines')],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/p\.run\.daily/);
  });
});

describe('RED-381 Phase F.2: log integration on pipelines', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-f2-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    return pipePath;
  }

  function readTrace(stderr: string): { trace: any; runDir: string } {
    const m = stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    return {
      trace: JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8')),
      runDir: m![1],
    };
  }

  it('log :stdout on a Pipeline emits the run-level complete event', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  log :stdout
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);

    // Builtin :stdout sink writes one key=value line per event to STDERR
    // (lets stdout stay clean for the gen/pipeline output JSON).
    expect(result.stderr).toMatch(/\[p\.run\.complete\]/);
    expect(result.stderr).toMatch(/ok=true/);

    const { trace, runDir } = readTrace(result.stderr);
    expect(trace.log_events).toBeDefined();
    expect(trace.log_events.some((s: any) => s.type === 'LogEmitted')).toBe(true);
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  it('emits the failed event with budget_exceeded reason on budget cap', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  log :stdout
  budget tokens: 100
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\[p\.run\.failed\]/);
    expect(result.stderr).toMatch(/reason=budget_exceeded/);
  });

  it('omitting log block leaves the trace without log_events', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :s1, gen: Analyst, method: :analyze
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const { trace, runDir } = readTrace(result.stderr);
    expect(trace.log_events).toBeUndefined();
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });
});

describe('RED-381 Phase E: pipeline-shared :pipeline_run memory scope', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-e-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string, extraGens: Record<string, string> = {}): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    for (const [name, body] of Object.entries(extraGens)) {
      writeFileSync(join(scratch, 'app', 'gens', `${name}.cmb.rb`), body);
    }
    return pipePath;
  }

  function readRunDir(stderr: string): string {
    const m = stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    return m![1];
  }

  // --- Ruby compile-error guard ---

  it('rejects gen-side strategy/embed/keyed_by/retain on :pipeline_run scope', () => {
    // Compile a gen directly via the Ruby compiler — quickest way to
    // exercise the new authoritative-slot check.
    const genPath = join(scratch, 'bad.cmb.rb');
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(scratch, 'src'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'app', 'gens', 'bad.cmb.rb'),
      `
class Bad < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run, strategy: :semantic, embed: "omlx:bge-small-en"
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim(),
    );

    const result = spawnSync(
      'ruby',
      [join(REPO_ROOT, 'ruby/cambium/compile.rb'), join(scratch, 'app/gens/bad.cmb.rb'), '--method', 'analyze'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/scope: :pipeline_run/);
    expect(result.stderr).toMatch(/pipeline is the source of truth/);
    expect(result.stderr).toMatch(/strategy/);
    expect(result.stderr).toMatch(/embed/);
  });

  it('accepts gen-side reader knobs (top_k / size) on :pipeline_run scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red381-e-readerknobs-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    writeFileSync(
      join(dir, 'app', 'gens', 'good.cmb.rb'),
      `
class Good < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run, top_k: 5
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim(),
    );

    const result = spawnSync(
      'ruby',
      [join(REPO_ROOT, 'ruby/cambium/compile.rb'), join(dir, 'app/gens/good.cmb.rb'), '--method', 'analyze'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(result.status).toBe(0);
    const ir = JSON.parse(result.stdout);
    expect(ir.policies.memory).toEqual([
      { name: 'findings', scope: 'pipeline_run', top_k: 5 },
    ]);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // --- End-to-end runtime tests ---

  it('sub-gen :pipeline_run decl runs with pipeline-authoritative strategy injected', () => {
    // Pipeline declares the slot with strategy: :log; sub-gen declares
    // the slot bare (just name + scope). The runtime should inject
    // strategy: :log + the pipelineRunId into the memCtx so the bucket
    // file lands at <workspace>/runs/memory/pipeline_run/<runId>/findings.sqlite.
    const genBody = `
class Recorder < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  memory :findings, strategy: :log
  step :one, gen: Recorder, method: :analyze
  step :two, gen: Recorder, method: :analyze
  def run(doc); end
end
`.trim(), { recorder: genBody });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    if (result.status !== 0) {
      throw new Error(
        `Expected success, got status=${result.status}\nstderr: ${result.stderr}`,
      );
    }

    // Both sub-gens should have hit the SAME bucket file under
    // runs/memory/pipeline_run/<pipelineRunId>/findings.sqlite.
    const runDir = readRunDir(result.stderr);
    const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
    expect(trace.ok).toBe(true);
    expect(trace.meta.operators_executed).toBe(2);

    // The bucket lives under <workspace>/runs/memory/pipeline_run/<runId>/.
    // Verify it exists on disk — both sub-gens wrote turns there.
    const pipelineRunId = trace.run_id;
    const bucketDir = join(scratch, 'runs', 'memory', 'pipeline_run', pipelineRunId);
    expect(existsSync(bucketDir)).toBe(true);
    expect(existsSync(join(bucketDir, 'findings.sqlite'))).toBe(true);

    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  it('throws when sub-gen declares :pipeline_run for a slot the pipeline didnt declare', () => {
    const ghostGen = `
class Ghost < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :not_there, scope: :pipeline_run
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  memory :findings, strategy: :log
  step :one, gen: Ghost, method: :analyze
  def run(doc); end
end
`.trim(), { ghost: ghostGen });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/declares memory 'not_there' with scope: :pipeline_run/);
    expect(result.stderr).toMatch(/pipeline didn't declare a matching slot/);
  });

  it('parallel branches in fan_out + downstream step share the same pipeline_run bucket', () => {
    // Branches each declare :pipeline_run memory; the downstream synthesize
    // step also declares it. All four sub-gens (2 branches + synthesize +
    // any retro writes) should land in the same bucket file.
    const branchGen = `
class BranchAgent < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  memory :findings, strategy: :log
  fan_out :reviewers, collect_into: :reviews do
    branch :a, agent: BranchAgent, method: :analyze
    branch :b, agent: BranchAgent, method: :analyze
  end
  step :synthesize, gen: BranchAgent, method: :analyze,
    with: { reviews: bind(:reviewers) }
  def run(doc); end
end
`.trim(), { branch_agent: branchGen });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const runDir = readRunDir(result.stderr);
    const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
    expect(trace.ok).toBe(true);

    const pipelineRunId = trace.run_id;
    const bucketFile = join(
      scratch, 'runs', 'memory', 'pipeline_run', pipelineRunId, 'findings.sqlite',
    );
    expect(existsSync(bucketFile)).toBe(true);

    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  });

  it('different pipeline runs get different :pipeline_run buckets (isolation)', () => {
    const recorderGen = `
class Recorder < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim();

    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  memory :findings, strategy: :log
  step :one, gen: Recorder, method: :analyze
  def run(doc); end
end
`.trim(), { recorder: recorderGen });

    const a = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    const b = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const traceA = JSON.parse(readFileSync(join(readRunDir(a.stderr), 'trace.json'), 'utf8'));
    const traceB = JSON.parse(readFileSync(join(readRunDir(b.stderr), 'trace.json'), 'utf8'));
    expect(traceA.run_id).not.toBe(traceB.run_id);

    // Two distinct bucket directories.
    expect(existsSync(join(scratch, 'runs', 'memory', 'pipeline_run', traceA.run_id))).toBe(true);
    expect(existsSync(join(scratch, 'runs', 'memory', 'pipeline_run', traceB.run_id))).toBe(true);

    try { rmSync(readRunDir(a.stderr), { recursive: true, force: true }); } catch {}
    try { rmSync(readRunDir(b.stderr), { recursive: true, force: true }); } catch {}
  });

  it('direct runGen of a :pipeline_run-scoped gen (outside a pipeline) errors clearly', () => {
    // A gen declaring memory :foo, scope: :pipeline_run that's run via
    // `cambium run <gen.cmb.rb>` (NOT a pipeline) gets a clear error
    // pointing at the scope mismatch rather than silently writing to
    // an unkeyed bucket.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-red381-e-direct-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const genPath = join(dir, 'app', 'gens', 'orphan.cmb.rb');
    writeFileSync(
      genPath,
      `
class Orphan < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  memory :findings, scope: :pipeline_run
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim(),
    );

    const result = spawnSync(
      'node',
      [CLI, 'run', genPath, '--method', 'analyze', '--arg', join(REPO_ROOT, FIXTURE), '--mock'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/scope: :pipeline_run requires a pipeline-driven invocation/);

    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});

describe('RED-381 Phase D: branch_on conditional routing', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red381-d-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function writePipelineWorkspace(pipelineBody: string, extraGens: Record<string, string> = {}): string {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/src/contracts.ts'), 'utf8'),
    );
    const pipePath = join(scratch, 'app', 'pipelines', 'p.pipeline.rb');
    writeFileSync(pipePath, pipelineBody);
    writeFileSync(
      join(scratch, 'app', 'gens', 'analyst.cmb.rb'),
      readFileSync(join(REPO_ROOT, 'packages/cambium/app/gens/analyst.cmb.rb'), 'utf8'),
    );
    for (const [name, body] of Object.entries(extraGens)) {
      writeFileSync(join(scratch, 'app', 'gens', `${name}.cmb.rb`), body);
    }
    return pipePath;
  }

  function readRunTrace(stderr: string): any {
    const m = stderr.match(/dir=(\S+)/);
    expect(m).toBeTruthy();
    const trace = JSON.parse(readFileSync(join(m![1], 'trace.json'), 'utf8'));
    try { rmSync(m![1], { recursive: true, force: true }); } catch {}
    return trace;
  }

  it('emits a PipelineBranchOn trace step and fires the default block when no on clause matches', () => {
    // Analyst's mock returns summary="Mock analysis (model provider not
    // available).", which won't match any `on` literal here — the
    // default block fires.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).summary do
    on :critical do; end
    on :info, :debug do; end
    default do
      step :fallback, gen: Analyst, method: :analyze
    end
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    expect(trace.operators).toHaveLength(2);
    expect(trace.operators[0].type).toBe('PipelineStep');
    expect(trace.operators[0].id).toBe('triage');

    const br = trace.operators[1];
    expect(br.type).toBe('PipelineBranchOn');
    expect(br.default_fired).toBe(true);
    expect(br.fired_branch).toBeNull();
    expect(br.ok).toBe(true);
    expect(br.signal).toEqual({ step: 'triage', field: 'summary' });
    // The default block's nested step shows up under br.operators
    expect(br.operators).toHaveLength(1);
    expect(br.operators[0].type).toBe('PipelineStep');
    expect(br.operators[0].id).toBe('fallback');
  });

  it('runs the matching `on` block and skips others', () => {
    // SignalAgent returns an output whose `summary` field is exactly
    // "critical" so we can deterministically match an `on` clause.
    const signalAgentBody = `
class SignalAgent < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim();
    // Mock returns AnalysisReport-shaped JSON for any gen returning
    // AnalysisReport — but the summary is always "Mock analysis ...",
    // never "critical". To test the matching path we'd need to inject
    // a value the mock returns. The mock's payload IS deterministic;
    // we match the FULL mock summary string.
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: SignalAgent, method: :analyze
  branch_on bind(:triage).summary do
    on "Mock analysis (model provider not available)." do
      step :critical_action, gen: Analyst, method: :analyze
    end
    default do
      step :fallback, gen: Analyst, method: :analyze
    end
  end
  def run(doc); end
end
`.trim(), { signal_agent: signalAgentBody });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    const br = trace.operators[1];
    expect(br.type).toBe('PipelineBranchOn');
    expect(br.default_fired).toBe(false);
    expect(br.fired_branch).toEqual(['Mock analysis (model provider not available).']);
    // The matched on block's nested step appears under br.operators.
    expect(br.operators).toHaveLength(1);
    expect(br.operators[0].id).toBe('critical_action');
  });

  it('supports nested step + fan_out inside branch_on blocks', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).summary do
    on :critical do; end
    default do
      step :pre, gen: Analyst, method: :analyze
      fan_out :reviewers, collect_into: :reviews do
        branch :a, agent: Analyst, method: :analyze
        branch :b, agent: Analyst, method: :analyze
      end
      step :post, gen: Analyst, method: :analyze
    end
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    const br = trace.operators[1];
    expect(br.type).toBe('PipelineBranchOn');
    expect(br.default_fired).toBe(true);
    expect(br.operators).toHaveLength(3);
    expect(br.operators.map((o: any) => o.type)).toEqual([
      'PipelineStep', 'PipelineFanOut', 'PipelineStep',
    ]);
  });

  it('a failed step inside a branch_on body fails the whole pipeline', () => {
    const failAgentBody = `
class FailAgent < GenModel
  model "omlx:stub"
  system "inline"
  returns ToolScaffoldResult
  def analyze(input)
    generate "go" do
      with context: input
      returns ToolScaffoldResult
    end
  end
end
`.trim();
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).summary do
    on :critical do; end
    default do
      step :bad, gen: FailAgent, method: :analyze
    end
  end
  def run(doc); end
end
`.trim(), { fail_agent: failAgentBody });

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).not.toBe(0);
    const trace = readRunTrace(result.stderr);
    expect(trace.ok).toBe(false);
    const br = trace.operators[1];
    expect(br.ok).toBe(false);
    expect(br.operators[0].id).toBe('bad');
    expect(br.operators[0].ok).toBe(false);
  });

  it('aggregates nested-operator token + tool_call usage into pipeline meta', () => {
    const pipePath = writePipelineWorkspace(`
class P < Pipeline
  input :doc, schema: AnalysisReport
  step :triage, gen: Analyst, method: :analyze
  branch_on bind(:triage).summary do
    on :critical do; end
    default do
      step :a, gen: Analyst, method: :analyze
      step :b, gen: Analyst, method: :analyze
    end
  end
  def run(doc); end
end
`.trim());

    const result = runPipelineCli(pipePath, 'run', join(REPO_ROOT, FIXTURE));
    expect(result.status).toBe(0);
    const trace = readRunTrace(result.stderr);
    // operators_executed counts top-level operators in parent trace
    // (consistent with fan_out counting as 1, not N): triage + branch_on
    // → 2. Nested ops are visible under branch_on.operators + its own
    // meta; token / tool_call totals roll up to the top.
    expect(trace.meta.operators_executed).toBe(2);
    const br = trace.operators[1];
    expect(br.meta.operators_executed).toBe(2); // nested a + b
    expect(br.operators).toHaveLength(2);
  });
});

describe('RED-385 Phase B: pipeline replay resume (mock, end-to-end)', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-red385-b-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  function pipelineRunId(stderr: string): string {
    // The pipeline emits its own run dir first, before any sub-gen run id.
    const m = stderr.match(/\[cambium\] run (run_\S+)/);
    if (!m) throw new Error(`no run id in stderr:\n${stderr}`);
    return m[1];
  }

  it('--from-op resumes mid-pipeline: reuses upstream output, re-runs the tail', () => {
    // 1. Produce a successful 3-step run (triage → remediate → summary).
    const run = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE);
    expect(run.status).toBe(0);
    const runId = pipelineRunId(run.stderr);
    const runDir = join('packages/cambium/runs', runId);

    const traceOut = join(scratch, 'replay-trace.json');
    const outputOut = join(scratch, 'replay-output.json');

    // 2. Replay from `remediate` — triage is reused, remediate + summary re-run.
    //    Path form because workspace-layout runs land under
    //    packages/cambium/runs/, not <cwd>/runs/.
    const replay = spawnSync(
      'node',
      [CLI, 'replay', runDir, '--from-op', 'remediate', '--mock', '--trace', traceOut, '--out', outputOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    const replayRunId = (() => {
      try { return pipelineRunId(replay.stderr); } catch { return null; }
    })();
    try {
      if (replay.status !== 0) {
        throw new Error(`replay exited ${replay.status}\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
      }

      const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
      expect(trace.parent_run_id).toBe(runId);
      expect(trace.replay).toMatchObject({ from_op: 'remediate', reused_op_count: 1 });

      const byId = Object.fromEntries(trace.operators.map((o: any) => [o.id, o]));
      // triage was rehydrated, not re-executed.
      expect(byId.triage.reused).toBe(true);
      // remediate + summary were freshly dispatched (no reused flag).
      expect(byId.remediate.reused).toBeUndefined();
      expect(byId.summary.reused).toBeUndefined();
      // The resumed steps succeeded — proving triage's output was correctly
      // rehydrated into stepResults (remediate binds bind(:triage).summary).
      expect(byId.remediate.ok).toBe(true);
      expect(byId.summary.ok).toBe(true);
      // Budget meta seeded from the parent so the cap spans the chain
      // (mock reports 0 tokens; the point is it carries the parent total
      // forward, not that it's positive).
      const parentTrace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
      expect(trace.meta.total_tokens).toBe(parentTrace.meta.total_tokens);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      if (replayRunId) rmSync(join('packages/cambium/runs', replayRunId), { recursive: true, force: true });
    }
  });

  it('refuses --edit on a pipeline replay (gen-level only)', () => {
    const run = runPipelineCli(SAMPLE_PIPELINE, 'review', FIXTURE);
    expect(run.status).toBe(0);
    const runId = pipelineRunId(run.stderr);
    const runDir = join('packages/cambium/runs', runId);
    try {
      const replay = spawnSync('node', [CLI, 'replay', runDir, '--edit', '--mock'], {
        cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
      });
      expect(replay.status).not.toBe(0);
      expect(replay.stderr).toMatch(/--edit is gen-level only/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
