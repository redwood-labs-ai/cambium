import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReplay, resolveRunDir } from './replay.js';

// RED-312: replay loader. Resolves a prior run's artifacts into the
// { ir, candidate, parentRunId } triple runGenFromIr resumes from.

let workspace: string;

function seedRun(
  id: string,
  { ir, output, trace }: { ir: any; output: unknown; trace?: any },
): string {
  const dir = join(workspace, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ir.json'), JSON.stringify(ir));
  writeFileSync(join(dir, 'output.json'), JSON.stringify(output));
  if (trace) writeFileSync(join(dir, 'trace.json'), JSON.stringify(trace));
  return dir;
}

const GEN_IR = {
  version: '0.2',
  entry: { class: 'Test', method: 'test', source: 'test.cmb.rb' },
  returnSchemaId: 'MockOutput',
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cambium-replay-ws-'));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('resolveRunDir', () => {
  it('resolves a bare run-id under <cwd>/runs/', () => {
    seedRun('run_aaa', { ir: GEN_IR, output: { summary: 'x' } });
    expect(resolveRunDir('run_aaa', workspace)).toBe(join(workspace, 'runs', 'run_aaa'));
  });

  it('accepts a path form', () => {
    const dir = seedRun('run_bbb', { ir: GEN_IR, output: { summary: 'x' } });
    expect(resolveRunDir(join('runs', 'run_bbb'), workspace)).toBe(dir);
  });

  it('throws a clear error when the run is not found', () => {
    expect(() => resolveRunDir('run_missing', workspace)).toThrow(/run not found/);
  });
});

describe('resolveReplay', () => {
  it('default checkpoint is output.json; lineage from trace.run_id', () => {
    seedRun('run_ccc', {
      ir: GEN_IR,
      output: { summary: 'the candidate' },
      trace: { run_id: 'run_ccc', steps: [] },
    });
    const r = resolveReplay({ runRef: 'run_ccc', cwd: workspace });
    expect(r.candidate).toEqual({ summary: 'the candidate' });
    expect(r.fromStep).toBe('output');
    expect(r.parentRunId).toBe('run_ccc');
  });

  it('falls back to the dir name for parentRunId when trace.json is absent', () => {
    seedRun('run_ddd', { ir: GEN_IR, output: { summary: 'x' } });
    const r = resolveReplay({ runRef: 'run_ddd', cwd: workspace });
    expect(r.parentRunId).toBe('run_ddd');
  });

  it('--from-step resolves the recorded output of the last matching step', () => {
    seedRun('run_eee', {
      ir: GEN_IR,
      output: { summary: 'final' },
      trace: {
        run_id: 'run_eee',
        steps: [
          { type: 'Generate', ok: true },
          { type: 'Correct', ok: true, output: { summary: 'first correct' } },
          { type: 'Correct', ok: true, output: { summary: 'second correct' } },
        ],
      },
    });
    const r = resolveReplay({ runRef: 'run_eee', cwd: workspace, fromStep: 'Correct' });
    expect(r.candidate).toEqual({ summary: 'second correct' }); // last instance wins
    expect(r.fromStep).toBe('Correct');
  });

  it('--from-step errors when no step of that type exists', () => {
    seedRun('run_fff', {
      ir: GEN_IR,
      output: { summary: 'x' },
      trace: { run_id: 'run_fff', steps: [{ type: 'Generate', ok: true }] },
    });
    expect(() => resolveReplay({ runRef: 'run_fff', cwd: workspace, fromStep: 'Correct' })).toThrow(
      /no step of type "Correct"/,
    );
  });

  it('--from-step errors when the step recorded no output (e.g. Generate)', () => {
    seedRun('run_ggg', {
      ir: GEN_IR,
      output: { summary: 'x' },
      trace: { run_id: 'run_ggg', steps: [{ type: 'Generate', ok: true, meta: { raw_preview: '...' } }] },
    });
    expect(() => resolveReplay({ runRef: 'run_ggg', cwd: workspace, fromStep: 'Generate' })).toThrow(
      /no resumable output value/,
    );
  });

  it('returns kind: "gen" for gen runs', () => {
    seedRun('run_hhh', { ir: GEN_IR, output: { summary: 'x' }, trace: { run_id: 'run_hhh', steps: [] } });
    const r = resolveReplay({ runRef: 'run_hhh', cwd: workspace });
    expect(r.kind).toBe('gen');
  });

  it('--from-op on a gen run errors (it is pipeline-level)', () => {
    seedRun('run_iii', { ir: GEN_IR, output: { summary: 'x' }, trace: { run_id: 'run_iii', steps: [] } });
    expect(() => resolveReplay({ runRef: 'run_iii', cwd: workspace, fromOp: 'fix' })).toThrow(
      /--from-op is pipeline-level/,
    );
  });
});

const PIPELINE_IR = {
  version: '0.2',
  kind: 'Pipeline',
  name: 'CiReview',
  entry: { class: 'CiReview', method: 'review', source: 'ci_review.pipeline.rb' },
  operators: [{ kind: 'Step', id: 'recon' }, { kind: 'FanOut', id: 'reviewers' }, { kind: 'Step', id: 'fix' }],
};

function pipelineTrace(opStates: Array<{ id: string; ok: boolean; output?: unknown }>): any {
  return {
    run_id: 'run_pipe',
    meta: { total_tokens: 1234, total_tool_calls: 5 },
    operators: opStates.map((o) => ({ type: 'PipelineStep', id: o.id, ok: o.ok, ...(o.output !== undefined ? { output: o.output } : {}) })),
  };
}

describe('resolveReplay — pipeline runs (RED-385 Phase B)', () => {
  it('returns kind: "pipeline" with the prior trace and null fromOp by default', () => {
    seedRun('run_pipe', {
      ir: PIPELINE_IR,
      output: { verdict: 'x' },
      trace: pipelineTrace([
        { id: 'recon', ok: true, output: { surface_map: 'm' } },
        { id: 'reviewers', ok: false },
      ]),
    });
    const r = resolveReplay({ runRef: 'run_pipe', cwd: workspace });
    expect(r.kind).toBe('pipeline');
    if (r.kind !== 'pipeline') throw new Error('narrowing');
    expect(r.fromOp).toBeNull();
    expect(r.parentRunId).toBe('run_pipe');
    expect(r.priorTrace.operators).toHaveLength(2);
  });

  it('accepts a valid --from-op', () => {
    seedRun('run_pipe', { ir: PIPELINE_IR, output: {}, trace: pipelineTrace([{ id: 'recon', ok: true }]) });
    const r = resolveReplay({ runRef: 'run_pipe', cwd: workspace, fromOp: 'fix' });
    if (r.kind !== 'pipeline') throw new Error('narrowing');
    expect(r.fromOp).toBe('fix');
  });

  it('rejects an unknown --from-op', () => {
    seedRun('run_pipe', { ir: PIPELINE_IR, output: {}, trace: pipelineTrace([{ id: 'recon', ok: true }]) });
    expect(() => resolveReplay({ runRef: 'run_pipe', cwd: workspace, fromOp: 'nope' })).toThrow(
      /not an operator of this pipeline/,
    );
  });

  it('--from-step on a pipeline errors (it is gen-level)', () => {
    seedRun('run_pipe', { ir: PIPELINE_IR, output: {}, trace: pipelineTrace([{ id: 'recon', ok: true }]) });
    expect(() => resolveReplay({ runRef: 'run_pipe', cwd: workspace, fromStep: 'Correct' })).toThrow(
      /--from-step is gen-level/,
    );
  });
});
