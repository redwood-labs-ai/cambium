// RED-313: trace → graph projection (the brains of `cambium inspect`).
//
// A pure function that turns a run's `trace.json` into a renderer-agnostic
// graph model: nodes (steps / operators / branches) + typed edges. The
// renderer (vanilla SVG) just draws this; all structural understanding lives
// here, where it's unit-testable against real captured traces.
//
// This deliberately rejects the abandoned spike's assumption that a run is a
// linear chain of `ir.steps`. Today's reality:
//   • a GEN trace is a (mostly linear) list of `steps[]`
//   • a PIPELINE trace is `{ type:'PipelineRun', operators[] }` where each
//     operator nests further:
//       - PipelineStep    → `trace` is a full sub-gen trace (its own steps[])
//       - PipelineFanOut  → `branches[]`, each a sub-gen trace
//       - PipelineBranchOn→ `trace.operators[]` (recursive)
//       - PipelineBudgetExceeded → terminal leaf
// The projection recurses through all of it, assigning each node a `parentId`
// + `depth` so the renderer can draw nested containers / layered columns.
//
// Source of truth is the TRACE (what the run did), never the IR (the plan).

export type NodeStatus = 'ok' | 'error' | 'warn' | 'skipped' | 'info';

/** kind: 'run' = the root, 'operator' = a pipeline operator, 'branch' = one
 *  fan-out branch, 'step' = a gen-level trace step. */
export type GraphNodeKind = 'run' | 'operator' | 'branch' | 'step';

export type GraphNode = {
  id: string;
  /** Containing group node (root / operator / branch). null only for the root. */
  parentId: string | null;
  kind: GraphNodeKind;
  /** Raw trace step/operator type — 'Generate', 'GroundingCheck',
   *  'PipelineStep', 'PipelineFanOut', etc. Drives icon/label choices. */
  stepType: string;
  label: string;
  status: NodeStatus;
  /** Nesting depth from the root (root = 0). */
  depth: number;
  ms?: number;
  tokens?: number;
  meta?: Record<string, any>;
  /** Present only when `includeOutputs` (default true). */
  output?: unknown;
};

export type GraphEdgeKind = 'sequence' | 'nested' | 'fanout' | 'branch' | 'lineage';

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
  /** Renderer hint: lineage / branch edges draw dashed. */
  dashed?: boolean;
};

export type GraphModel = {
  runId: string;
  kind: 'gen' | 'pipeline';
  /** Root node id. */
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Set when the trace carries `parent_run_id` (a replay child). The renderer
   *  draws this as a dotted stub / badge; it's cross-run, not an intra-graph
   *  edge. */
  lineage?: { parentRunId: string };
  /** Pipeline rollup meta (tokens, tool_calls, caps) when present. */
  meta?: Record<string, any>;
};

export type ProjectOptions = {
  /** Carry full per-node `output` + `meta` (default true). Set false for a
   *  lightweight list/overview projection. */
  includeOutputs?: boolean;
};

// ── status mapping ────────────────────────────────────────────────────────
// ok:false → error; explicit warn markers → warn; ok:true → ok; otherwise
// neutral 'info' (many gen steps omit `ok`). A soft-failed grounding/corrector
// step (meta.failed truthy, not hard-failing) surfaces as a warning.
function statusOf(item: any): NodeStatus {
  if (!item || typeof item !== 'object') return 'info';
  if (item.ok === false) return 'error';
  if (item.type === 'CorrectAcceptedWithErrors') return 'warn';
  if (item.meta && item.meta.failed) return 'warn';
  if (Array.isArray(item.errors) && item.errors.length > 0 && item.ok !== true) return 'warn';
  if (item.ok === true) return 'ok';
  return 'info';
}

function aggregateStatus(statuses: NodeStatus[]): NodeStatus {
  return statuses.includes('error') ? 'error' : statuses.includes('warn') ? 'warn' : 'ok';
}

/** kind + status + label for the run as a whole — shared by the root node in
 *  `projectTrace` and the lightweight `summarizeTrace` (list endpoint). */
function rootInfo(trace: any): { kind: 'gen' | 'pipeline'; status: NodeStatus; label: string } {
  const entry = trace?.entry ?? {};
  const entryClass = entry.class ?? entry.className ?? trace?.name ?? 'run';
  if (trace?.type === 'PipelineRun') {
    return {
      kind: 'pipeline',
      status: trace.ok === false ? 'error' : trace.ok === true ? 'ok' : 'info',
      label: String(trace.name ?? entryClass),
    };
  }
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  return {
    kind: 'gen',
    status: aggregateStatus(steps.map(statusOf)),
    label: entry.method ? `${entryClass}#${entry.method}` : String(entryClass),
  };
}

export type TraceSummary = {
  runId: string;
  kind: 'gen' | 'pipeline';
  status: NodeStatus;
  label: string;
  startedAt?: string;
  parentRunId?: string;
};

/** Cheap one-pass summary for the runs list — no node/edge building. */
export function summarizeTrace(trace: any): TraceSummary {
  return {
    runId: String(trace?.run_id ?? 'run'),
    ...rootInfo(trace),
    startedAt: trace?.started_at,
    parentRunId: trace?.parent_run_id ? String(trace.parent_run_id) : undefined,
  };
}

function msBetween(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const a = Date.parse(startedAt);
  const b = Date.parse(finishedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return b - a;
}

function operatorLabel(op: any): string {
  switch (op.type) {
    case 'PipelineStep':
      return op.gen ? `${op.id} · ${op.gen}#${op.method}` : String(op.id ?? 'step');
    case 'PipelineFanOut':
      return `${op.id} · fan_out`;
    case 'PipelineBranchOn':
      return `branch_on ${op.signal}${op.signal_value != null ? ` = ${op.signal_value}` : ''}`;
    case 'PipelineBudgetExceeded':
      return 'budget exceeded';
    default:
      return op.id ? `${op.type} · ${op.id}` : String(op.type);
  }
}

type Ctx = { nodes: GraphNode[]; edges: GraphEdge[]; includeOutputs: boolean };

function edge(source: string, target: string, kind: GraphEdgeKind, label?: string): GraphEdge {
  return {
    id: `${source}~>${target}:${kind}`,
    source,
    target,
    kind,
    label,
    dashed: kind === 'branch' || kind === 'lineage',
  };
}

/** Project a flat gen-step list under `parentId`. Returns the first/last node
 *  ids so the caller can wire a nested/sequence edge into the chain. */
function projectGenSteps(
  steps: any[],
  parentId: string,
  depth: number,
  ctx: Ctx,
): { firstId: string | null; lastId: string | null } {
  let prev: string | null = null;
  let firstId: string | null = null;
  let lastId: string | null = null;
  steps.forEach((s, i) => {
    const id = `${parentId}::s${i}-${s.type}`;
    ctx.nodes.push({
      id,
      parentId,
      kind: 'step',
      stepType: s.type,
      label: s.type,
      status: statusOf(s),
      depth,
      ms: typeof s.ms === 'number' ? s.ms : undefined,
      meta: ctx.includeOutputs ? s.meta : undefined,
      output: ctx.includeOutputs ? s.output : undefined,
    });
    if (prev) ctx.edges.push(edge(prev, id, 'sequence'));
    else firstId = id;
    prev = id;
    lastId = id;
  });
  return { firstId, lastId };
}

/** Project a pipeline operator list under `parentId` (recursive for branch_on).
 *  Returns first/last operator node ids. */
function projectOperators(
  operators: any[],
  parentId: string,
  depth: number,
  ctx: Ctx,
): { firstId: string | null; lastId: string | null } {
  let prevOp: string | null = null;
  let firstId: string | null = null;
  let lastId: string | null = null;

  operators.forEach((op, i) => {
    const opId = `${parentId}::${op.type}-${op.id ?? i}`;
    ctx.nodes.push({
      id: opId,
      parentId,
      kind: 'operator',
      stepType: op.type,
      label: operatorLabel(op),
      status: statusOf(op),
      depth,
      ms: msBetween(op.started_at, op.finished_at),
      tokens: op.meta && typeof op.meta.tokens === 'number' ? op.meta.tokens : undefined,
      meta: ctx.includeOutputs ? op.meta : undefined,
      output: ctx.includeOutputs ? op.output : undefined,
    });
    if (prevOp) ctx.edges.push(edge(prevOp, opId, 'sequence'));
    else firstId = opId;
    prevOp = opId;
    lastId = opId;

    // ── recurse into nested content ──────────────────────────────────────
    if (op.type === 'PipelineStep' && op.trace && Array.isArray(op.trace.steps)) {
      const r = projectGenSteps(op.trace.steps, opId, depth + 1, ctx);
      if (r.firstId) ctx.edges.push(edge(opId, r.firstId, 'nested'));
    } else if (op.type === 'PipelineFanOut' && Array.isArray(op.branches)) {
      op.branches.forEach((b: any, bi: number) => {
        const branchId = `${opId}::branch-${b.branch_id ?? bi}`;
        ctx.nodes.push({
          id: branchId,
          parentId: opId,
          kind: 'branch',
          stepType: 'FanOutBranch',
          label: String(b.branch_id ?? `branch ${bi}`),
          status: statusOf(b),
          depth: depth + 1,
          meta: ctx.includeOutputs && b.error ? { error: b.error } : undefined,
          output: ctx.includeOutputs ? b.output : undefined,
        });
        ctx.edges.push(edge(opId, branchId, 'fanout'));
        if (b.trace && Array.isArray(b.trace.steps)) {
          const r = projectGenSteps(b.trace.steps, branchId, depth + 2, ctx);
          if (r.firstId) ctx.edges.push(edge(branchId, r.firstId, 'nested'));
        }
      });
    } else if (op.type === 'PipelineBranchOn' && op.trace && Array.isArray(op.trace.operators)) {
      const fired = Array.isArray(op.fired_branch) ? op.fired_branch.join(',') : op.default_fired ? 'default' : undefined;
      const r = projectOperators(op.trace.operators, opId, depth + 1, ctx);
      if (r.firstId) ctx.edges.push(edge(opId, r.firstId, 'branch', fired));
    }
    // PipelineBudgetExceeded and any unknown leaf type: no recursion.
  });

  return { firstId, lastId };
}

/**
 * Project a parsed `trace.json` into a graph model. Pure + deterministic
 * (no clock / randomness) so it's fully unit-testable.
 */
export function projectTrace(trace: any, opts: ProjectOptions = {}): GraphModel {
  const includeOutputs = opts.includeOutputs !== false;
  const ctx: Ctx = { nodes: [], edges: [], includeOutputs };
  const runId = String(trace?.run_id ?? 'run');
  const isPipeline = trace?.type === 'PipelineRun';
  const rootId = `root:${runId}`;
  const info = rootInfo(trace);

  ctx.nodes.push({
    id: rootId,
    parentId: null,
    kind: 'run',
    stepType: isPipeline ? 'PipelineRun' : 'GenRun',
    label: info.label,
    status: info.status,
    depth: 0,
    meta: includeOutputs
      ? isPipeline
        ? trace.meta
        : trace?.model
          ? { model: trace.model }
          : undefined
      : undefined,
  });

  if (isPipeline) {
    const r = projectOperators(Array.isArray(trace.operators) ? trace.operators : [], rootId, 1, ctx);
    if (r.firstId) ctx.edges.push(edge(rootId, r.firstId, 'nested'));
  } else {
    const r = projectGenSteps(Array.isArray(trace?.steps) ? trace.steps : [], rootId, 1, ctx);
    if (r.firstId) ctx.edges.push(edge(rootId, r.firstId, 'nested'));
  }

  const model: GraphModel = {
    runId,
    kind: isPipeline ? 'pipeline' : 'gen',
    root: rootId,
    nodes: ctx.nodes,
    edges: ctx.edges,
  };
  if (trace?.parent_run_id) model.lineage = { parentRunId: String(trace.parent_run_id) };
  if (isPipeline && trace?.meta) model.meta = trace.meta;
  return model;
}
