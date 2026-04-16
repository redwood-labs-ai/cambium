import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryEntry } from './types.js';

/**
 * RED-215 phase 3+5: SQLite-backed storage for one memory bucket.
 *
 * The native SQLite deps are loaded dynamically so Cambium installs
 * that don't use memory never pay for the native build. A gen that
 * declares `memory :...` triggers the import on first use; if it
 * fails, the user gets a clear "install better-sqlite3 and sqlite-vec"
 * pointer rather than an opaque MODULE_NOT_FOUND at startup.
 *
 * Phase 3 schema: single `entries` table (log / sliding_window).
 * Phase 5 schema adds: `meta` table (pins embedding model + dim so
 * later runs can't silently mix shapes) and `entries_vec` virtual
 * table via sqlite-vec. Both are created lazily on first semantic use.
 */

// Cache module handles across calls — dynamic import is idempotent but
// caching keeps every Backend open path to exactly one resolve cost
// per process.
let _databaseCtor: any = null;
let _sqliteVec: any = null;

async function loadDatabase(): Promise<any> {
  if (_databaseCtor) return _databaseCtor;
  try {
    const mod: any = await import('better-sqlite3');
    _databaseCtor = mod.default ?? mod;
    return _databaseCtor;
  } catch (e: any) {
    throw new Error(
      "Cambium memory subsystem requires 'better-sqlite3'. Install with:\n" +
        '  npm install better-sqlite3 sqlite-vec\n' +
        `(underlying error: ${e?.message ?? e})`,
    );
  }
}

async function loadSqliteVec(): Promise<any> {
  if (_sqliteVec) return _sqliteVec;
  try {
    _sqliteVec = await import('sqlite-vec');
    return _sqliteVec;
  } catch (e: any) {
    throw new Error(
      "Cambium :semantic memory requires 'sqlite-vec'. Install with:\n" +
        '  npm install sqlite-vec\n' +
        `(underlying error: ${e?.message ?? e})`,
    );
  }
}

export class SqliteMemoryBackend {
  private constructor(private db: any, public readonly path: string) {}

  /**
   * Open (or create) the bucket at `path`. Installs the `entries` table
   * and WAL pragma. Vector tables are NOT created here — that happens
   * on first semantic use via `initSemantic` so non-semantic buckets
   * never load the sqlite-vec extension.
   */
  static async open(path: string): Promise<SqliteMemoryBackend> {
    mkdirSync(dirname(path), { recursive: true });
    const Database = await loadDatabase();
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        content TEXT NOT NULL,
        written_by TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return new SqliteMemoryBackend(db, path);
  }

  /** Append one entry; returns id + byte size. */
  append(content: string, writtenBy: string = 'default'): { id: number; bytes: number } {
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO entries (ts, content, written_by) VALUES (?, ?, ?)',
    );
    const result = stmt.run(ts, content, writtenBy);
    return { id: Number(result.lastInsertRowid), bytes: Buffer.byteLength(content, 'utf8') };
  }

  /** Return up to `n` most-recent entries, chronological (oldest-first). */
  readRecent(n: number): MemoryEntry[] {
    if (n <= 0) return [];
    const rows = this.db
      .prepare('SELECT id, ts, content, written_by FROM entries ORDER BY id DESC LIMIT ?')
      .all(n) as MemoryEntry[];
    return rows.reverse();
  }

  /**
   * Ensure the bucket is ready for semantic storage with the given
   * embedding model/dim. On first call: loads sqlite-vec, creates the
   * entries_vec virtual table, and pins `embed_model` + `embed_dim`
   * into `meta`. On subsequent calls: validates the pin matches and
   * errors clearly on mismatch — you can't mix dims in one bucket.
   */
  async initSemantic(embedModel: string, embedDim: number): Promise<void> {
    // Extension loads are per-connection, so we always call sqliteVec.load
    // — even if the meta pinning was done on a prior run. Skipping this
    // leaves the connection without the vec0 module, which would then
    // fail only when the caller tries to query entries_vec. Load first,
    // validate second.
    if (!this._vecLoaded) {
      const sqliteVec = await loadSqliteVec();
      sqliteVec.load(this.db);
      this._vecLoaded = true;
    }

    const existingModel = this.getMeta('embed_model');
    const existingDim = this.getMeta('embed_dim');

    if (existingModel !== null || existingDim !== null) {
      if (existingModel !== embedModel) {
        throw new Error(
          `memory bucket at ${this.path} was initialized with embed_model ` +
            `'${existingModel}' — cannot now use '${embedModel}'. ` +
            "Delete the bucket or use a different memory `name` to start fresh.",
        );
      }
      if (existingDim !== String(embedDim)) {
        throw new Error(
          `memory bucket at ${this.path} has embed_dim ${existingDim}, ` +
            `but embedding returned dim ${embedDim}. Model change detected.`,
        );
      }
      return;
    }

    // First semantic use on this bucket — create the virtual table + pin.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(` +
        `entry_id INTEGER PRIMARY KEY, content_vec FLOAT[${embedDim}])`,
    );
    this.setMeta('embed_model', embedModel);
    this.setMeta('embed_dim', String(embedDim));
  }

  private _vecLoaded = false;

  /**
   * Append an entry and its embedding in one transaction. Returns the
   * entry id + byte size so the caller can emit a normal write trace.
   * `initSemantic` must have been called first (idempotent, so the
   * caller can unconditionally call it before every semantic write).
   */
  appendSemantic(
    content: string,
    embedding: Float32Array,
    writtenBy: string = 'default',
  ): { id: number; bytes: number } {
    const ts = new Date().toISOString();
    const txn = this.db.transaction((c: string, vec: Float32Array, by: string) => {
      const result = this.db
        .prepare('INSERT INTO entries (ts, content, written_by) VALUES (?, ?, ?)')
        .run(ts, c, by);
      const idNum = Number(result.lastInsertRowid);
      // vec0 enforces strict integer typing on INTEGER PRIMARY KEY —
      // pass a BigInt so better-sqlite3 binds it as SQLITE_INTEGER.
      // (Plain JS numbers can bind as SQLITE_REAL and get rejected.)
      this.db
        .prepare('INSERT INTO entries_vec (entry_id, content_vec) VALUES (?, ?)')
        .run(BigInt(idNum), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      return idNum;
    });
    const id = txn(content, embedding, writtenBy);
    return { id, bytes: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * Top-k nearest-neighbor search against a query embedding. Returns
   * matching entry rows in ascending-distance order (closest first),
   * each with the vec_distance as an extra `score` field on the row.
   * Requires `initSemantic` to have been called (loads the extension).
   */
  searchSemantic(query: Float32Array, k: number): Array<MemoryEntry & { score: number }> {
    if (k <= 0) return [];
    // vec0's query planner requires the LIMIT (or `k = ?`) constraint
    // to appear in the same SELECT as the MATCH — a JOIN wrapping the
    // MATCH breaks that. Do the knn query in a CTE, then join out.
    const rows = this.db
      .prepare(
        `WITH top_ids AS (
           SELECT entry_id, distance
           FROM entries_vec
           WHERE content_vec MATCH ?
           ORDER BY distance ASC
           LIMIT ?
         )
         SELECT e.id, e.ts, e.content, e.written_by, t.distance AS score
         FROM top_ids t
         JOIN entries e ON e.id = t.entry_id
         ORDER BY t.distance ASC`,
      )
      .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), k);
    return rows as Array<MemoryEntry & { score: number }>;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
