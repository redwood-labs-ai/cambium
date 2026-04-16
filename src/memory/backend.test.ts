import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryBackend } from './backend.js';

describe('SqliteMemoryBackend (RED-215 phase 3)', () => {
  function freshBucket(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-memory-'));
    return join(dir, 'test.sqlite');
  }

  it('appends entries and reads them in chronological order', () => {
    const path = freshBucket();
    const b = new SqliteMemoryBackend(path);
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

  it('limits readRecent to last N entries when more exist', () => {
    const path = freshBucket();
    const b = new SqliteMemoryBackend(path);
    for (let i = 0; i < 5; i++) b.append(JSON.stringify({ i }));

    const last2 = b.readRecent(2);
    expect(last2.map(e => JSON.parse(e.content).i)).toEqual([3, 4]);
    b.close();
    rmSync(path, { force: true });
  });

  it('returns [] for readRecent(0) without hitting the db', () => {
    const path = freshBucket();
    const b = new SqliteMemoryBackend(path);
    b.append(JSON.stringify({ x: 1 }));
    expect(b.readRecent(0)).toEqual([]);
    b.close();
    rmSync(path, { force: true });
  });

  it('persists across backend instances (file-backed)', () => {
    const path = freshBucket();
    const b1 = new SqliteMemoryBackend(path);
    b1.append(JSON.stringify({ seeded: true }));
    b1.close();

    const b2 = new SqliteMemoryBackend(path);
    const entries = b2.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0].content).seeded).toBe(true);
    b2.close();
    rmSync(path, { force: true });
  });

  it('tracks bytes and ids on append', () => {
    const path = freshBucket();
    const b = new SqliteMemoryBackend(path);
    const content = JSON.stringify({ hello: 'world' });
    const { id, bytes } = b.append(content);
    expect(id).toBe(1);
    expect(bytes).toBe(Buffer.byteLength(content, 'utf8'));
    b.close();
    rmSync(path, { force: true });
  });

  it('records written_by and returns it on read', () => {
    const path = freshBucket();
    const b = new SqliteMemoryBackend(path);
    b.append('x', 'agent:SupportMemoryAgent');
    const [e] = b.readRecent(1);
    expect(e.written_by).toBe('agent:SupportMemoryAgent');
    b.close();
    rmSync(path, { force: true });
  });
});
