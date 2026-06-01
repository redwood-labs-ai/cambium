import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectTrace, type GraphModel, type GraphNode } from './projection.js';

// RED-313: projection tests run against captured/faithful trace fixtures
// (gen-linear, gen-replay-child, pipeline-steps are REAL traces from
// `cambium run --mock`; pipeline-fanout/branchon embed the real gen trace
// inside hand-assembled operator wrappers matching the runner's exact shapes).

const FX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const load = (name: string) => JSON.parse(readFileSync(join(FX, name), 'utf8'));

const byId = (m: GraphModel) => new Map(m.nodes.map((n) => [n.id, n] as const));
const childrenOf = (m: GraphModel, parentId: string) => m.nodes.filter((n) => n.parentId === parentId);
const edgesOfKind = (m: GraphModel, kind: string) => m.edges.filter((e) => e.kind === kind);
// Walk parentId up to the root; returns true if `nodeId` is reachable from root.
function reachesRoot(m: GraphModel, nodeId: string): boolean {
  const map = byId(m);
  let cur: GraphNode | undefined = map.get(nodeId);
  const seen = new Set<string>();
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) return false; // cycle guard
    seen.add(cur.id);
    cur = map.get(cur.parentId);
  }
  return !!cur && cur.id === m.root;
}

describe('projectTrace — gen (linear)', () => {
  const model = projectTrace(load('gen-linear.trace.json'));

  it('is a gen graph rooted at a GenRun node', () => {
    expect(model.kind).toBe('gen');
    const root = byId(model).get(model.root)!;
    expect(root.kind).toBe('run');
    expect(root.stepType).toBe('GenRun');
    expect(root.label).toMatch(/Analyst#analyze/);
  });

  it('projects each trace step as a node chained by sequence edges', () => {
    const steps = model.nodes.filter((n) => n.kind === 'step');
    expect(steps.map((s) => s.stepType)).toEqual([
      'SecurityCheck', 'Generate', 'Review', 'Correct', 'GroundingCheck', 'ExtractSignals', 'ToolCall',
    ]);
    // root → first step is a 'nested' edge; the rest are 'sequence'.
    expect(edgesOfKind(model, 'nested')).toHaveLength(1);
    expect(edgesOfKind(model, 'sequence')).toHaveLength(steps.length - 1);
    // every step hangs off the root.
    expect(steps.every((s) => s.parentId === model.root)).toBe(true);
  });

  it('maps ok:true steps to ok status and carries ms when present', () => {
    const gen = model.nodes.find((n) => n.stepType === 'Generate')!;
    expect(gen.status).toBe('ok');
    expect(typeof gen.ms).toBe('number');
    // steps without a numeric ms (SecurityCheck) leave ms undefined, not 0/NaN.
    const sec = model.nodes.find((n) => n.stepType === 'SecurityCheck')!;
    expect(sec.ms).toBeUndefined();
  });

  it('has no lineage (not a replay child)', () => {
    expect(model.lineage).toBeUndefined();
  });
});

describe('projectTrace — gen (replay child)', () => {
  const model = projectTrace(load('gen-replay-child.trace.json'));

  it('exposes parent_run_id as lineage', () => {
    expect(model.lineage?.parentRunId).toBe('run_20260529_144847_7ceed0');
  });

  it('includes the ReplayResume step from the replayed tail', () => {
    expect(model.nodes.some((n) => n.stepType === 'ReplayResume')).toBe(true);
  });
});

describe('projectTrace — pipeline (steps)', () => {
  const model = projectTrace(load('pipeline-steps.trace.json'));

  it('is a pipeline graph rooted at PipelineRun with operator nodes', () => {
    expect(model.kind).toBe('pipeline');
    expect(byId(model).get(model.root)!.stepType).toBe('PipelineRun');
    const ops = childrenOf(model, model.root).filter((n) => n.kind === 'operator');
    expect(ops.map((o) => o.stepType)).toEqual(['PipelineStep', 'PipelineStep', 'PipelineStep']);
  });

  it('nests each sub-gen trace under its PipelineStep (reachable from root)', () => {
    const ops = childrenOf(model, model.root);
    for (const op of ops) {
      const nested = childrenOf(model, op.id).filter((n) => n.kind === 'step');
      expect(nested.length).toBeGreaterThan(0);
      expect(nested.every((s) => reachesRoot(model, s.id))).toBe(true);
    }
  });

  it('carries pipeline rollup meta + a nested edge into the first operator', () => {
    expect(model.meta?.total_tokens).toBeDefined();
    expect(edgesOfKind(model, 'nested').length).toBeGreaterThan(0);
  });
});

describe('projectTrace — pipeline (fan_out)', () => {
  const model = projectTrace(load('pipeline-fanout.trace.json'));

  it('renders fan-out branches as branch nodes with fanout edges', () => {
    const fanout = model.nodes.find((n) => n.stepType === 'PipelineFanOut')!;
    const branches = childrenOf(model, fanout.id).filter((n) => n.kind === 'branch');
    expect(branches.map((b) => b.label).sort()).toEqual(['performance', 'security']);
    expect(edgesOfKind(model, 'fanout')).toHaveLength(2);
  });

  it('maps a failed branch to error status and a passing one to ok', () => {
    const sec = model.nodes.find((n) => n.label === 'security')!;
    const perf = model.nodes.find((n) => n.label === 'performance')!;
    expect(sec.status).toBe('ok');
    expect(perf.status).toBe('error');
    expect(perf.meta?.error).toMatch(/validation failed/);
  });

  it('nests each branch sub-gen trace under its branch node', () => {
    const perf = model.nodes.find((n) => n.label === 'performance')!;
    expect(childrenOf(model, perf.id).filter((n) => n.kind === 'step').length).toBeGreaterThan(0);
  });
});

describe('projectTrace — pipeline (branch_on)', () => {
  const model = projectTrace(load('pipeline-branchon.trace.json'));

  it('nests the fired branch operators under the branch_on node with a labeled branch edge', () => {
    const branchOn = model.nodes.find((n) => n.stepType === 'PipelineBranchOn')!;
    expect(branchOn.label).toMatch(/branch_on severity = critical/);
    const nestedOps = childrenOf(model, branchOn.id).filter((n) => n.kind === 'operator');
    expect(nestedOps.map((o) => o.stepType)).toEqual(['PipelineStep']);
    const branchEdge = edgesOfKind(model, 'branch')[0];
    expect(branchEdge.label).toBe('critical');
    expect(branchEdge.dashed).toBe(true);
  });
});

describe('projectTrace — options', () => {
  it('includeOutputs:false drops per-node output + meta', () => {
    const model = projectTrace(load('gen-linear.trace.json'), { includeOutputs: false });
    expect(model.nodes.every((n) => n.output === undefined)).toBe(true);
    expect(model.nodes.every((n) => n.meta === undefined)).toBe(true);
  });

  it('is deterministic (same input → identical model)', () => {
    const t = load('pipeline-fanout.trace.json');
    expect(projectTrace(t)).toEqual(projectTrace(t));
  });
});
