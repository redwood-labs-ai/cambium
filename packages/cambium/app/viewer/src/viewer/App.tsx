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

  // Be forgiving about the input shape. We primarily care about a steps[] array.
  const irLike: IRRoot | null = useMemo(() => {
    if (!parsed) return null;
    if (Array.isArray((parsed as any).steps)) return parsed as IRRoot;
    if ((parsed as any).ir && Array.isArray((parsed as any).ir.steps)) return (parsed as any).ir as IRRoot;
    return null;
  }, [parsed]);

  const { nodes, edges, graphError } = useMemo(() => {
    if (!irLike) return { nodes: [], edges: [], graphError: parsed ? 'No steps[] found (expected .steps or .ir.steps)' : null };
    try {
      const { nodes, edges } = toFlowNodesEdges(irLike);
      return { nodes, edges, graphError: null };
    } catch (e: any) {
      return { nodes: [], edges: [], graphError: e?.message ?? String(e) };
    }
  }, [irLike, parsed]);

  const selected = useMemo(() => {
    if (!selectedNodeId || !irLike) return null;
    return irLike.steps.find((s) => s.id === selectedNodeId) ?? null;
  }, [irLike, selectedNodeId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr 420px', height: '100vh' }}>
      <div style={{ padding: 12, borderRight: '1px solid #ddd', overflow: 'auto' }}>
        <h3>IR (paste JSON)</h3>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
          {irLike ? (
            <span>Loaded <b>{irLike.steps.length}</b> step(s).</span>
          ) : parsed ? (
            <span style={{ color: 'crimson' }}>Parsed JSON, but no steps[] found.</span>
          ) : (
            <span style={{ color: 'crimson' }}>Invalid JSON.</span>
          )}
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
