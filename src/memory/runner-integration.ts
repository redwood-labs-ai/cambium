import type { MemoryDecl, MemoryPlan, MemoryRunContext, MemoryEntry } from './types.js';
import { SqliteMemoryBackend } from './backend.js';
import { resolveBucketPath } from './path.js';
import { formatMemoryBlock } from './prompt-block.js';
import { embedText } from '../providers/embed.js';

/**
 * RED-215 phase 3+5: tie the memory module into the runner's lifecycle.
 *
 * Two integration points:
 *   - `planMemory` + `readMemoryForRun` run before `Generate`. Output
 *     is a string to splice into the system prompt plus trace steps.
 *   - `commitMemoryWrites` runs after a successful generation and
 *     appends one turn (the trivial default) to every writable bucket.
 *
 * Phase 5 adds `:semantic`:
 *   - read path: embed ctx.input → top-k vec search → inject as a
 *     "### <name> (top K semantic hits)" section of the Memory block.
 *   - write path: embed the content → append into entries + entries_vec
 *     in one transaction. Embed model + dim pinned on first write.
 */

export type MemoryTraceStep = {
  id: string;
  type: 'memory.read' | 'memory.write' | 'memory.prune';
  ok: boolean;
  meta: Record<string, unknown>;
};

export function planMemory(decls: MemoryDecl[], ctx: MemoryRunContext): MemoryPlan[] {
  return decls.map(d => {
    if (d.strategy === 'semantic' && !d.embed) {
      throw new Error(
        `memory '${d.name}' strategy :semantic requires an embed model. ` +
          'Set `embed:` on the memory decl or the pool.',
      );
    }
    const bucketPath = resolveBucketPath(d, ctx);
    let readN: number | null;
    if (d.strategy === 'sliding_window') readN = d.size ?? 10;
    else if (d.strategy === 'semantic') readN = d.top_k ?? 5;
    else readN = null; // :log — write-only
    return { decl: d, bucketPath, readN, writable: true };
  });
}

/**
 * Open each planned bucket, read its recent entries (when the strategy
 * asks for reads), and return a formatted block to inject plus trace
 * steps. Backends are kept open and returned so commit can reuse them
 * without re-paying the SQLite open cost.
 *
 * Semantic reads embed `ctx.input` once per decl and run a vec-search.
 * Empty buckets return zero hits (no error) — the read block just
 * omits that section.
 */
export async function readMemoryForRun(
  plans: MemoryPlan[],
  ctx: MemoryRunContext,
): Promise<{
  block: string | null;
  trace: MemoryTraceStep[];
  backends: Map<string, SqliteMemoryBackend>;
}> {
  const trace: MemoryTraceStep[] = [];
  const sections: Array<{ decl: MemoryDecl; entries: MemoryEntry[] }> = [];
  const backends = new Map<string, SqliteMemoryBackend>();

  for (const plan of plans) {
    const backend = await SqliteMemoryBackend.open(plan.bucketPath);
    backends.set(plan.decl.name, backend);

    // RED-239: prune before reading. Retention is enforced here (not
    // on write) because reads are what expose stale data to the model;
    // a bucket that's never read stays fat but never injects. `:log`
    // decls fall through to this path too — they have readN:null but
    // still benefit from TTL/cap enforcement at run start.
    if (plan.decl.retain) {
      const r = plan.decl.retain;
      const counts = backend.prune(r);
      if (counts.ttl_count > 0) {
        trace.push({
          id: `memory_prune_${plan.decl.name}_ttl`,
          type: 'memory.prune',
          ok: true,
          meta: {
            scope: plan.decl.scope,
            name: plan.decl.name,
            reason: 'ttl',
            count: counts.ttl_count,
            ttl_seconds: r.ttl_seconds,
          },
        });
      }
      if (counts.cap_count > 0) {
        trace.push({
          id: `memory_prune_${plan.decl.name}_cap`,
          type: 'memory.prune',
          ok: true,
          meta: {
            scope: plan.decl.scope,
            name: plan.decl.name,
            reason: 'cap',
            count: counts.cap_count,
            max_entries: r.max_entries,
          },
        });
      }
    }

    if (plan.readN === null) {
      // :log — write-only strategy. Emit a zero-hit event for trace
      // parity so the memory.read step always appears per decl.
      trace.push(zeroReadTrace(plan.decl, 'strategy :log does not read — this event marks the no-op for trace parity'));
      continue;
    }

    if (plan.decl.strategy === 'semantic') {
      // No entries yet = no query needed; skip embed cost.
      const countRow = backend.readRecent(1);
      if (countRow.length === 0) {
        trace.push(zeroReadTrace(plan.decl, 'bucket empty — no semantic query run'));
        continue;
      }
      // RED-238: resolve query source (literal `query:` > `arg_field:` > ctx.input default).
      const resolved = resolveSemanticQuery(plan.decl, ctx.input);
      const embedModel = plan.decl.embed!;
      const { vector, dim } = await embedText(embedModel, resolved.text);
      await backend.initSemantic(embedModel, dim);
      const hits = backend.searchSemantic(vector, plan.readN);
      sections.push({ decl: plan.decl, entries: hits });
      trace.push({
        id: `memory_read_${plan.decl.name}`,
        type: 'memory.read',
        ok: true,
        meta: {
          strategy: 'semantic',
          scope: plan.decl.scope,
          name: plan.decl.name,
          k: plan.readN,
          hits: hits.length,
          bytes: hits.reduce((s, e) => s + Buffer.byteLength(e.content, 'utf8'), 0),
          embed_model: embedModel,
          embed_dim: dim,
          query_source: resolved.source,
          query_preview: truncateForTrace(resolved.text),
        },
      });
      continue;
    }

    // :sliding_window
    const entries = backend.readRecent(plan.readN);
    sections.push({ decl: plan.decl, entries });
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
        bytes: entries.reduce((s, e) => s + Buffer.byteLength(e.content, 'utf8'), 0),
      },
    });
  }

  return { block: formatMemoryBlock(sections), trace, backends };
}

function zeroReadTrace(decl: MemoryDecl, note: string): MemoryTraceStep {
  return {
    id: `memory_read_${decl.name}`,
    type: 'memory.read',
    ok: true,
    meta: {
      strategy: decl.strategy, scope: decl.scope, name: decl.name,
      k: 0, hits: 0, bytes: 0, note,
    },
  };
}

/**
 * RED-238: resolve the nearest-neighbor query text for a `:semantic`
 * read. Three paths:
 *   - `decl.query` set → literal string passthrough.
 *   - `decl.arg_field` set → parse `ctx.input` as JSON and pluck the
 *     named top-level field. Missing field or non-JSON input throws
 *     with decl-local context so the author can see which slot failed.
 *     Non-string field values are JSON-stringified (embedding tolerates
 *     noise better than silently dropping them).
 *   - Neither set → phase-5 default (`ctx.input`).
 * Returns the resolved text and a `source` tag for trace meta.
 * Exported for direct unit testing; the runner calls it inline.
 */
export function resolveSemanticQuery(
  decl: MemoryDecl,
  ctxInput: string,
): { text: string; source: 'literal' | 'arg_field' | 'default' } {
  if (decl.query !== undefined) {
    return { text: decl.query, source: 'literal' };
  }
  if (decl.arg_field !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctxInput);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `memory '${decl.name}' requested arg_field: '${decl.arg_field}' but ctx.input is not valid JSON (${msg}). ` +
          `arg_field requires a JSON-shaped --arg. Switch to query: "<literal>" or pass JSON input.`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `memory '${decl.name}' requested arg_field: '${decl.arg_field}' but ctx.input parsed as ${
          Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed
        }, not a JSON object.`,
      );
    }
    const record = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, decl.arg_field)) {
      throw new Error(
        `memory '${decl.name}' requested arg_field: '${decl.arg_field}' which is not present in ctx.input. ` +
          `Available top-level fields: [${Object.keys(record).join(', ')}].`,
      );
    }
    const value = record[decl.arg_field];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { text, source: 'arg_field' };
  }
  return { text: ctxInput, source: 'default' };
}

/**
 * RED-238: trace payloads are user-facing (printed / indexed /
 * compared). Keep the query preview bounded so a huge JSON blob
 * doesn't balloon the trace or leak more than needed.
 */
function truncateForTrace(s: string): string {
  const MAX = 200;
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

/**
 * Commit the turn to every writable bucket. Phase 3 trivial default:
 * one `{ input, output }` entry per writable bucket, `written_by:
 * 'default'`. For `:semantic` buckets, also embed the content and
 * insert the vec row in the same transaction.
 */
export async function commitMemoryWrites(
  plans: MemoryPlan[],
  backends: Map<string, SqliteMemoryBackend>,
  input: string,
  output: unknown,
): Promise<MemoryTraceStep[]> {
  const content = JSON.stringify({ input, output });
  const trace: MemoryTraceStep[] = [];

  for (const plan of plans) {
    if (!plan.writable) continue;
    const backend = backends.get(plan.decl.name);
    if (!backend) continue;

    if (plan.decl.strategy === 'semantic') {
      const embedModel = plan.decl.embed!;
      const { vector, dim } = await embedText(embedModel, content);
      await backend.initSemantic(embedModel, dim);
      const { id, bytes } = backend.appendSemantic(content, vector, 'default');
      trace.push({
        id: `memory_write_${plan.decl.name}`,
        type: 'memory.write',
        ok: true,
        meta: {
          scope: plan.decl.scope, name: plan.decl.name,
          entry_id: id, bytes, written_by: 'default',
          strategy: 'semantic', embed_model: embedModel, embed_dim: dim,
        },
      });
      continue;
    }

    const { id, bytes } = backend.append(content, 'default');
    trace.push({
      id: `memory_write_${plan.decl.name}`,
      type: 'memory.write',
      ok: true,
      meta: {
        scope: plan.decl.scope, name: plan.decl.name,
        entry_id: id, bytes, written_by: 'default',
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
