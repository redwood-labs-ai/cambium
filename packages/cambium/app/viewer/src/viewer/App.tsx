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
      return JSON.parse(irText) as IRRoot;
    } catch {
      return null;
    }
  }, [irText]);

  const { nodes, edges } = useMemo(() => {
    if (!parsed) return { nodes: [], edges: [] };
    return toFlowNodesEdges(parsed);
  }, [parsed]);

  const selected = useMemo(() => {
    if (!selectedNodeId || !parsed) return null;
    return parsed.steps.find((s) => s.id === selectedNodeId) ?? null;
  }, [parsed, selectedNodeId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr 420px', height: '100vh' }}>
      <div style={{ padding: 12, borderRight: '1px solid #ddd', overflow: 'auto' }}>
        <h3>IR (paste JSON)</h3>
        <textarea
          style={{ width: '100%', height: '90%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
          value={irText}
          onChange={(e) => setIrText(e.target.value)}
        />
      </div>

      <div style={{ position: 'relative' }}>
        <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, n) => setSelectedNodeId(n.id)}>
          <Background />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </div>

      <div style={{ padding: 12, borderLeft: '1px solid #ddd', overflow: 'auto' }}>
        <h3>Node details</h3>
        {!parsed && <div style={{ color: 'crimson' }}>Invalid JSON</div>}
        {!selected && <div>Select a node.</div>}
        {selected && <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(selected, null, 2)}</pre>}
      </div>
    </div>
  );
}
