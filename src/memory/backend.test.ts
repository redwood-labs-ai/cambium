import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryBackend } from './backend.js';
import { mockEmbed, MOCK_DIM } from '../providers/embed.js';

describe('SqliteMemoryBackend (RED-215 phase 3+5)', () => {
  function freshBucket(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-memory-'));
    return join(dir, 'test.sqlite');
  }

  it('appends entries and reads them in chronological order', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    b.append(JSON.stringify({ input: 'first', output: 'a' }));
    b.append(JSON.stringify({ input: 'second', output: 'b' }));
    b.append(JSON.stringify({ input: 'third', output: 'c' }));

    const entries = b.readRecent(10);
    expect(entries).toHaveLength(3);
    expect(JSON.parse(entries[0].content).input).toBe('first');
    expect(JSON.parse(entries[2].content).input).toBe('third');
    b.close();
    rmSync(path, { force: true });
  });

  it('limits readRecent to last N entries when more exist', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    for (let i = 0; i < 5; i++) b.append(JSON.stringify({ i }));

    const last2 = b.readRecent(2);
    expect(last2.map(e => JSON.parse(e.content).i)).toEqual([3, 4]);
    b.close();
    rmSync(path, { force: true });
  });

  it('returns [] for readRecent(0) without hitting the db', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    b.append(JSON.stringify({ x: 1 }));
    expect(b.readRecent(0)).toEqual([]);
    b.close();
    rmSync(path, { force: true });
  });

  it('persists across backend instances (file-backed)', async () => {
    const path = freshBucket();
    const b1 = await SqliteMemoryBackend.open(path);
    b1.append(JSON.stringify({ seeded: true }));
    b1.close();

    const b2 = await SqliteMemoryBackend.open(path);
    const entries = b2.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].content).seeded).toBe(true);
    b2.close();
    rmSync(path, { force: true });
  });

  it('tracks bytes and ids on append', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    const content = JSON.stringify({ hello: 'world' });
    const { id, bytes } = b.append(content);
    expect(id).toBe(1);
    expect(bytes).toBe(Buffer.byteLength(content, 'utf8'));
    b.close();
    rmSync(path, { force: true });
  });

  it('records written_by and returns it on read', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    b.append('x', 'agent:SupportMemoryAgent');
    const [e] = b.readRecent(1);
    expect(e.written_by).toBe('agent:SupportMemoryAgent');
    b.close();
    rmSync(path, { force: true });
  });
});

describe('SqliteMemoryBackend.prune (RED-239)', () => {
  function freshBucket(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-prune-'));
    return join(dir, 'p.sqlite');
  }

  it('drops entries older than ttl_seconds', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    // Three entries. Rewrite the two oldest to have timestamps in the past.
    b.append('keep-new');
    b.append('drop-old-1');
    b.append('drop-old-2');
    const longAgo = new Date(Date.now() - 10 * 86_400 * 1000).toISOString();
    (b as any).db.prepare('UPDATE entries SET ts = ? WHERE content LIKE ?').run(longAgo, 'drop-old-%');

    const counts = b.prune({ ttl_seconds: 7 * 86_400 });
    expect(counts.ttl_count).toBe(2);
    expect(counts.cap_count).toBe(0);

    const remaining = b.readRecent(10).map(e => e.content);
    expect(remaining).toEqual(['keep-new']);
    b.close();
    rmSync(path, { force: true });
  });

  it('keeps the newest max_entries and drops the overflow', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    for (let i = 0; i < 7; i++) b.append(`entry-${i}`);

    const counts = b.prune({ max_entries: 3 });
    expect(counts.cap_count).toBe(4);
    expect(counts.ttl_count).toBe(0);

    const remaining = b.readRecent(10).map(e => e.content);
    expect(remaining).toEqual(['entry-4', 'entry-5', 'entry-6']);
    b.close();
    rmSync(path, { force: true });
  });

  it('is a no-op when neither dimension is exceeded', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    b.append('a');
    b.append('b');
    const counts = b.prune({ ttl_seconds: 86_400, max_entries: 10 });
    expect(counts.ttl_count).toBe(0);
    expect(counts.cap_count).toBe(0);
    expect(b.readRecent(10)).toHaveLength(2);
    b.close();
    rmSync(path, { force: true });
  });

  it('prunes entries_vec rows alongside entries for semantic buckets', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);
    b.appendSemantic('one', mockEmbed('one', MOCK_DIM));
    b.appendSemantic('two', mockEmbed('two', MOCK_DIM));
    b.appendSemantic('three', mockEmbed('three', MOCK_DIM));

    // Cap at 1 — two vec rows should be dropped alongside entries.
    b.prune({ max_entries: 1 });

    const entriesRow = (b as any).db.prepare('SELECT COUNT(*) AS n FROM entries').get();
    const vecRow = (b as any).db.prepare('SELECT COUNT(*) AS n FROM entries_vec').get();
    expect(entriesRow.n).toBe(1);
    expect(vecRow.n).toBe(1);
    b.close();
    rmSync(path, { force: true });
  });
});

describe('SqliteMemoryBackend semantic (RED-215 phase 5)', () => {
  function freshBucket(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-sem-'));
    return join(dir, 'sem.sqlite');
  }

  it('initSemantic is idempotent for the same model+dim', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);
    await b.initSemantic('mock:bge-small', MOCK_DIM); // should not throw
    expect(b.getMeta('embed_model')).toBe('mock:bge-small');
    expect(b.getMeta('embed_dim')).toBe(String(MOCK_DIM));
    b.close();
    rmSync(path, { force: true });
  });

  it('rejects a different embed model on the same bucket', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);
    await expect(b.initSemantic('mock:different-model', MOCK_DIM))
      .rejects.toThrow(/cannot now use/);
    b.close();
    rmSync(path, { force: true });
  });

  it('rejects a different embed dim on the same bucket', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);
    await expect(b.initSemantic('mock:bge-small', MOCK_DIM + 1))
      .rejects.toThrow(/embed_dim/);
    b.close();
    rmSync(path, { force: true });
  });

  it('appendSemantic + searchSemantic round-trips and returns nearest by content', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);

    // Seed three distinct entries.
    const entries = ['alpha doc', 'beta doc', 'gamma doc'];
    for (const e of entries) {
      b.appendSemantic(e, mockEmbed(e, MOCK_DIM));
    }

    // Query with the exact text of one seeded entry — it should be the
    // closest match (distance 0) because mockEmbed is deterministic.
    const hits = b.searchSemantic(mockEmbed('beta doc', MOCK_DIM), 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('beta doc');
    expect(hits[0].score).toBeCloseTo(0, 3);
    b.close();
    rmSync(path, { force: true });
  });

  it('top-k ordering is ascending by distance (closest first)', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);

    b.appendSemantic('first', mockEmbed('first', MOCK_DIM));
    b.appendSemantic('second', mockEmbed('second', MOCK_DIM));
    b.appendSemantic('third', mockEmbed('third', MOCK_DIM));

    const hits = b.searchSemantic(mockEmbed('second', MOCK_DIM), 3);
    expect(hits[0].content).toBe('second');        // closest (exact match)
    expect(hits[0].score).toBeCloseTo(0, 3);
    expect(hits[1].score).toBeGreaterThan(0);       // others are farther
    expect(hits[2].score).toBeGreaterThanOrEqual(hits[1].score);
    b.close();
    rmSync(path, { force: true });
  });

  it('searchSemantic on an empty vec table returns []', async () => {
    const path = freshBucket();
    const b = await SqliteMemoryBackend.open(path);
    await b.initSemantic('mock:bge-small', MOCK_DIM);
    expect(b.searchSemantic(mockEmbed('anything', MOCK_DIM), 5)).toEqual([]);
    b.close();
    rmSync(path, { force: true });
  });
});
