/**
 * RED-215 phase 3: runtime types for the memory primitive.
 *
 * The compile-time side of this lives in ruby/cambium/runtime.rb +
 * ruby/cambium/compile.rb. The types here mirror the IR shape emitted
 * there (see "IR shape emitted by phase 2" in docs/GenDSL Docs/P -
 * Memory (design note).md).
 */

/** One memory declaration, post-pool-resolution (pool slots already merged in). */
export type MemoryDecl = {
  name: string;
  scope: string; // 'session' | 'global' | named pool
  strategy: 'sliding_window' | 'log' | 'semantic';
  size?: number;
  top_k?: number;
  keyed_by?: string;
  embed?: string;
  /** RED-239: retention policy. Both keys optional; either-or-both enforced. */
  retain?: {
    ttl_seconds?: number;
    max_entries?: number;
  };
  /**
   * RED-238: configurable query source for `:semantic` reads.
   * Mutually exclusive with `arg_field`. When neither is set, the read
   * path falls back to `ctx.input` (phase-5 default).
   */
  query?: string;
  /**
   * RED-238: pluck a top-level field out of `ctx.input` (parsed as JSON)
   * and use it as the nearest-neighbor query. Mutually exclusive with
   * `query`. Non-JSON `ctx.input` or a missing field raises at read time.
   */
  arg_field?: string;
};

/** Resolved execution plan for one MemoryDecl — what the runner will do with it this run. */
export type MemoryPlan = {
  decl: MemoryDecl;
  bucketPath: string;      // runs/memory/<scope>/<key>/<name>.sqlite
  readN: number | null;    // null = no read path (e.g. :log); number = last N entries
  writable: boolean;       // phase 3: all supported strategies write the trivial default turn
};

/** Run-time inputs the runner collects before invoking the memory layer. */
export type MemoryRunContext = {
  /** The --arg content the gen was invoked with — stored as the "input" half of the turn. */
  input: string;
  /** Resolved session id (from CAMBIUM_SESSION_ID or auto-gen). */
  sessionId: string;
  /** Values provided via --memory-key name=value, already parsed. */
  keys: Record<string, string>;
  /** Writable root for run artifacts; memory lives under `${runsRoot}/memory/…`. */
  runsRoot: string;
  /** RED-305: schedule id when this run is a scheduled fire (--fired-by).
   *  Present only for scheduled invocations; memory decls with scope:
   *  :schedule use this as the bucket key. */
  scheduleId?: string;
};

/** One entry as stored in the SQLite `entries` table. */
export type MemoryEntry = {
  id: number;
  ts: string;       // ISO 8601
  content: string;  // JSON: { input, output } today; could extend later
  written_by: string;
};
