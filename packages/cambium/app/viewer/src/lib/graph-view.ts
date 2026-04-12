import type { IRRoot, IRStep } from './ir';

export type GraphNode = { id: string; type: string; label: string; stepId: string; meta?: Record<string, any> };
export type GraphEdge = { id: string; source: string; target: string; label?: string };
export type GraphViewModel = { version: 0; nodes: GraphNode[]; edges: GraphEdge[] };

function stepLabel(step: IRStep): string {
  return step.name ?? step.type;
}

export function irToGraphViewModel(ir: IRRoot): GraphViewModel {
  const nodes = ir.steps.map((s) => ({
    id: s.id,
    stepId: s.id,
    type: s.type,
    label: stepLabel(s),
    meta: { ...('meta' in s ? (s as any).meta : undefined) },
  }));

  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `${nodes[i].id}__to__${nodes[i + 1].id}`, source: nodes[i].id, target: nodes[i + 1].id });
  }

  return { version: 0, nodes, edges };
}
