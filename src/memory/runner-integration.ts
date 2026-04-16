import type { MemoryDecl, MemoryPlan, MemoryRunContext, MemoryEntry } from './types.js';
import { SqliteMemoryBackend } from './backend.js';
import { resolveBucketPath } from './path.js';
import { formatMemoryBlock } from './prompt-block.js';

/**
 * RED-215 phase 3: tie the memory module into the runner's lifecycle.
 *
 * Two integration points:
 *   - `planMemory` + `readMemoryForRun` run before `Generate`. Output
 *     is a string to splice into the system prompt plus trace steps.
 *   - `commitMemoryWrites` runs after a successful generation and
 *     appends one turn (the trivial default) to every writable bucket.
 *
 * Phase 3 rejects :semantic at plan time with a clear "phase 5" error.
 * No silent skips — a gen that declared semantic memory wants semantic
 * memory, and a silently-empty memory block is worse than an error.
 */

export type MemoryTraceStep = {
  id: string;
  type: 'memory.read' | 'memory.write' | 'memory.prune';
  ok: boolean;
  meta: Record<string, unknown>;
};

export function planMemory(decls: MemoryDecl[], ctx: MemoryRunContext): MemoryPlan[] {
  return decls.map(d => {
    if (d.strategy === 'semantic') {
      throw new Error(
        `memory '${d.name}' strategy :semantic is not executable yet (phase 5, RED-215). ` +
          'Use :sliding_window or :log until semantic support lands.',
      );
    }
    const bucketPath = resolveBucketPath(d, ctx);
    const readN = d.strategy === 'sliding_window' ? (d.size ?? 10) : null;
    return { decl: d, bucketPath, readN, writable: true };
  });
}

/**
 * Open each planned bucket, read its recent entries (when the strategy
 * asks for reads), and return a formatted block to inject plus trace
 * steps. Backends are kept open and returned so commit can reuse them
 * without re-paying the SQLite open cost.
 */
export function readMemoryForRun(
  plans: MemoryPlan[],
): { block: string | null; trace: MemoryTraceStep[]; backends: Map<string, SqliteMemoryBackend> } {
  const trace: MemoryTraceStep[] = [];
  const sections: Array<{ decl: MemoryDecl; entries: MemoryEntry[] }> = [];
  const backends = new Map<string, SqliteMemoryBackend>();

  for (const plan of plans) {
    const backend = new SqliteMemoryBackend(plan.bucketPath);
    backends.set(plan.decl.name, backend);

    if (plan.readN === null) {
      trace.push({
        id: `memory_read_${plan.decl.name}`,
        type: 'memory.read',
        ok: true,
        meta: {
          strategy: plan.decl.strategy,
          scope: plan.decl.scope,
          name: plan.decl.name,
          k: 0,
          hits: 0,
          bytes: 0,
          note: 'strategy :log does not read — this event marks the no-op for trace parity',
        },
      });
      continue;
    }

    const entries = backend.readRecent(plan.readN);
    sections.push({ decl: plan.decl, entries });
    const bytes = entries.reduce((sum, e) => sum + Buffer.byteLength(e.content, 'utf8'), 0);
    trace.push({
      id: `memory_read_${plan.decl.name}`,
      type: 'memory.read',
      ok: true,
      meta: {
        strategy: plan.decl.strategy,
        scope: plan.decl.scope,
        name: plan.decl.name,
        k: plan.readN,
        hits: entries.length,
        bytes,
      },
    });
  }

  return { block: formatMemoryBlock(sections), trace, backends };
}

/**
 * Commit the turn to every writable bucket. Phase 3 uses the trivial
 * default — one entry of `{ input, output }`, written_by: 'default'.
 * Phase 4 will route through a memory agent when one is declared.
 */
export function commitMemoryWrites(
  plans: MemoryPlan[],
  backends: Map<string, SqliteMemoryBackend>,
  input: string,
  output: unknown,
): MemoryTraceStep[] {
  const content = JSON.stringify({ input, output });
  const trace: MemoryTraceStep[] = [];

  for (const plan of plans) {
    if (!plan.writable) continue;
    const backend = backends.get(plan.decl.name);
    if (!backend) continue; // defensive — planMemory should have created one
    const { id, bytes } = backend.append(content, 'default');
    trace.push({
      id: `memory_write_${plan.decl.name}`,
      type: 'memory.write',
      ok: true,
      meta: {
        scope: plan.decl.scope,
        name: plan.decl.name,
        entry_id: id,
        bytes,
        written_by: 'default',
      },
    });
  }

  return trace;
}

export function closeBackends(backends: Map<string, SqliteMemoryBackend>): void {
  for (const b of backends.values()) {
    try { b.close(); } catch { /* best effort */ }
  }
}
