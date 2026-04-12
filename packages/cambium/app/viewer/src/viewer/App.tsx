import React, { useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';

// For now, we import from the repo root TS sources.
// This is intentionally simple; we can package/share later.
import type { IRRoot } from "../lib/ir";
import { irToGraphViewModel } from "../lib/graph-view";

const EXAMPLE_IR: IRRoot = {
  version: 0,
  model: 'omlx:example',
  context: { document: 'Hello' },
  returnSchemaId: 'Example',
  steps: [{ id: 'generate_1', type: 'Generate', name: 'Generate' }],
};

function toFlowNodesEdges(ir: IRRoot): { nodes: Node[]; edges: Edge[] } {
  const g = irToGraphViewModel(ir);
  const nodes: Node[] = g.nodes.map((n, idx) => ({
    id: n.id,
    position: { x: idx * 260, y: 80 },
    data: { label: n.label, node: n },
    type: 'default',
  }));
  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
    label: e.label,
  }));
  return { nodes, edges };
}

export default function App() {
  const [irText, setIrText] = useState<string>(JSON.stringify(EXAMPLE_IR, null, 2));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const parsed = useMemo(() => {
    try {
      return JSON.parse(irText) as any;
    } catch {
      return null;
    }
  }, [irText]);

  // Be forgiving about the input shape.
  // We support either an IR-like object (with steps[]) or a Trace-like object (with steps[] but different shape).
  const detected = useMemo(() => {
    if (!parsed) return { kind: 'none' as const };

    const steps = (parsed as any).steps;
    if (!Array.isArray(steps)) return { kind: 'unknown' as const };

    // Heuristic: trace steps always have {type, ok?, meta?} and often lack prompt/returns.
    const looksTrace = steps.length > 0 && typeof steps[0]?.type === 'string' && !('returns' in (steps[0] ?? {}));
    if (looksTrace) return { kind: 'trace' as const, trace: parsed as any };

    return { kind: 'ir' as const, ir: parsed as IRRoot };
  }, [parsed]);

  const { nodes, edges, graphError, loadedLabel } = useMemo(() => {
    if (!parsed) return { nodes: [], edges: [], graphError: null, loadedLabel: 'Invalid JSON.' };

    // IR path
    if (detected.kind === 'ir') {
      try {
        const { nodes, edges } = toFlowNodesEdges(detected.ir);
        return {
          nodes,
          edges,
          graphError: null,
          loadedLabel: `Loaded ${detected.ir.steps.length} IR step(s).`,
        };
      } catch (e: any) {
        return { nodes: [], edges: [], graphError: e?.message ?? String(e), loadedLabel: 'Parsed IR, but failed to render.' };
      }
    }

    // Trace path: render trace.steps linearly
    if (detected.kind === 'trace') {
      const tSteps = (detected.trace.steps ?? []) as any[];
      try {
        const nodes: Node[] = tSteps.map((s, idx) => ({
          id: String(s.id ?? `trace_${idx}`),
          position: { x: idx * 260, y: 80 },
          data: { label: s.type ?? 'Step', step: s },
          type: 'default',
        }));
        const edges: Edge[] = [];
        for (let i = 0; i < nodes.length - 1; i++) {
          edges.push({ id: `${nodes[i].id}__to__${nodes[i + 1].id}`, source: nodes[i].id, target: nodes[i + 1].id });
        }
        return {
          nodes,
          edges,
          graphError: null,
          loadedLabel: `Loaded ${tSteps.length} trace step(s).`,
        };
      } catch (e: any) {
        return { nodes: [], edges: [], graphError: e?.message ?? String(e), loadedLabel: 'Parsed trace, but failed to render.' };
      }
    }

    return { nodes: [], edges: [], graphError: 'No steps[] found.', loadedLabel: 'Parsed JSON, but no steps[] found.' };
  }, [parsed, detected]);

  const selected = useMemo(() => {
    if (!selectedNodeId || !parsed) return null;

    if (detected.kind === 'ir') {
      return detected.ir.steps.find((s) => s.id === selectedNodeId) ?? null;
    }
    if (detected.kind === 'trace') {
      const tSteps = (detected.trace.steps ?? []) as any[];
      return tSteps.find((s, idx) => String(s.id ?? `trace_${idx}`) === selectedNodeId) ?? null;
    }

    return null;
  }, [parsed, detected, selectedNodeId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr 420px', height: '100vh' }}>
      <div style={{ padding: 12, borderRight: '1px solid #ddd', overflow: 'auto' }}>
        <h3>IR (paste JSON)</h3>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
          {loadedLabel}
        </div>
        <textarea
          style={{ width: '100%', height: '90%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
          value={irText}
          onChange={(e) => setIrText(e.target.value)}
        />
      </div>

      <div style={{ position: 'relative', height: '100%' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          onNodeClick={(_, n) => setSelectedNodeId(n.id)}
          style={{ width: '100%', height: '100%' }}
        >
          <Background />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </div>

      <div style={{ padding: 12, borderLeft: '1px solid #ddd', overflow: 'auto' }}>
        <h3>Node details</h3>
        {graphError && <div style={{ color: 'crimson', marginBottom: 8 }}>{graphError}</div>}
        {!selected && <div>Select a node.</div>}
        {selected && <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(selected, null, 2)}</pre>}
      </div>
    </div>
  );
}
