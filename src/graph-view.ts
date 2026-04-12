import type { IRRoot, IRStep } from './ir.js';

export type GraphPort = {
  id: string;
  label?: string;
};

export type GraphNode = {
  id: string;
  type: string;
  label: string;
  stepId: string;
  inputs?: GraphPort[];
  outputs?: GraphPort[];
  meta?: Record<string, any>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
};

export type GraphViewModel = {
  version: 0;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function stepLabel(step: IRStep): string {
  return step.name ?? step.type;
}

/**
 * Minimal projection: today the runner is effectively linear over ir.steps.
 * Render as a chain. Later we can enrich this from a real DAG IR.
 */
export function irToGraphViewModel(ir: IRRoot): GraphViewModel {
  const nodes: GraphNode[] = ir.steps.map((s) => ({
    id: s.id,
    stepId: s.id,
    type: s.type,
    label: stepLabel(s),
    inputs: [{ id: 'in' }],
    outputs: [{ id: 'out' }],
    meta: { ...('meta' in s ? (s as any).meta : undefined) },
  }));

  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    edges.push({
      id: `${a.id}__to__${b.id}`,
      source: a.id,
      target: b.id,
      sourcePort: 'out',
      targetPort: 'in',
    });
  }

  return { version: 0, nodes, edges };
}
