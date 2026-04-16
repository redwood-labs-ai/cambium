import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryEntry } from './types.js';

/**
 * RED-215 phase 3: SQLite-backed storage for one memory bucket.
 *
 * Every memory decl resolves to a single SQLite file holding an
 * append-only log of turns. Phase 3 uses only the `entries` table;
 * phase 5 will add a sqlite-vec virtual table alongside it for
 * semantic search without relocating any data.
 *
 * Lifecycle: construct with a filesystem path; the dir is created if
 * needed, the schema is applied idempotently. `append` adds one row;
 * `readRecent(n)` returns up to n rows in chronological order.
 */
export class SqliteMemoryBackend {
  private db: Database.Database;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        content TEXT NOT NULL,
        written_by TEXT NOT NULL DEFAULT 'default'
      );
    `);
  }

  /** Append one entry; returns the assigned id and the byte size of the JSON content. */
  append(content: string, writtenBy: string = 'default'): { id: number; bytes: number } {
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO entries (ts, content, written_by) VALUES (?, ?, ?)',
    );
    const result = stmt.run(ts, content, writtenBy);
    return { id: Number(result.lastInsertRowid), bytes: Buffer.byteLength(content, 'utf8') };
  }

  /** Return up to `n` most-recent entries, in chronological (oldest-first) order. */
  readRecent(n: number): MemoryEntry[] {
    if (n <= 0) return [];
    const rows = this.db
      .prepare('SELECT id, ts, content, written_by FROM entries ORDER BY id DESC LIMIT ?')
      .all(n) as MemoryEntry[];
    return rows.reverse();
  }

  close(): void {
    this.db.close();
  }
}
