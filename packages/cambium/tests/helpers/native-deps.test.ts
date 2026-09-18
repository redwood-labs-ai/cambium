import { describe, it, expect } from 'vitest';
import { betterSqlite3Available, sqliteVecAvailable } from './native-deps.js';

/**
 * The crux this guards against: an unconditional/hardcoded skip would
 * silently delete every SQLite-backed CLI test's coverage while turning
 * the suite green — indistinguishable from success at a glance. These
 * tests prove `betterSqlite3Available` / `sqliteVecAvailable` are genuine
 * resolvability probes by driving both branches with injected importers,
 * and prove the real (uninjected) call path — the one every other test
 * file actually uses — agrees with a plain dynamic import of its own.
 */

class FakeDatabase {
  constructor(_path: string) {}
  close() {}
}

describe('betterSqlite3Available', () => {
  it('resolves true when the module is importable and constructible', async () => {
    const ok = await betterSqlite3Available(async () => ({ default: FakeDatabase }));
    expect(ok).toBe(true);
  });

  it('resolves false when the import rejects', async () => {
    const ok = await betterSqlite3Available(async () => {
      throw new Error('Cannot find package \'better-sqlite3\'');
    });
    expect(ok).toBe(false);
  });

  it('resolves false when the import succeeds but construction throws', async () => {
    class ThrowsOnConstruct {
      constructor() {
        throw new Error('native binding failed to load');
      }
    }
    const ok = await betterSqlite3Available(async () => ({ default: ThrowsOnConstruct }));
    expect(ok).toBe(false);
  });

  it('the real (uninjected) call path agrees with a plain dynamic import + construct', async () => {
    // Construct, not just import: better-sqlite3 loads its native binding
    // lazily, so a binding built for another Node ABI imports fine and
    // only throws here — exactly the case the probe must report false.
    const real = await betterSqlite3Available();
    let expected = true;
    try {
      const { default: Database } = await import('better-sqlite3' as any) as any;
      new Database(':memory:').close();
    } catch {
      expected = false;
    }
    expect(real).toBe(expected);
  });
});

describe('sqliteVecAvailable', () => {
  it('resolves true when both modules import and the extension loads', async () => {
    const ok = await sqliteVecAvailable(
      async () => ({ default: FakeDatabase }),
      async () => ({ load: () => {} }),
    );
    expect(ok).toBe(true);
  });

  it('resolves false when better-sqlite3 itself is unavailable', async () => {
    const ok = await sqliteVecAvailable(
      async () => { throw new Error('Cannot find package \'better-sqlite3\''); },
      async () => ({ load: () => {} }),
    );
    expect(ok).toBe(false);
  });

  it('resolves false when sqlite-vec fails to import (e.g. musl host)', async () => {
    const ok = await sqliteVecAvailable(
      async () => ({ default: FakeDatabase }),
      async () => { throw new Error('cannot open shared object file'); },
    );
    expect(ok).toBe(false);
  });

  it('resolves false when sqlite-vec imports but .load() throws', async () => {
    const ok = await sqliteVecAvailable(
      async () => ({ default: FakeDatabase }),
      async () => ({ load: () => { throw new Error('invalid ELF header'); } }),
    );
    expect(ok).toBe(false);
  });

  it('the real (uninjected) call path agrees with a plain dynamic import + load', async () => {
    const real = await sqliteVecAvailable();
    let expected = true;
    try {
      const { default: Database } = await import('better-sqlite3' as any) as any;
      const sqliteVec: any = await import('sqlite-vec' as any);
      const db = new Database(':memory:');
      sqliteVec.load(db);
      db.close();
    } catch {
      expected = false;
    }
    expect(real).toBe(expected);
  });
});
