/**
 * RED-305: memory scope :schedule — bucket path routing + missing-fire guard.
 */
import { describe, it, expect } from 'vitest';
import { resolveBucketPath } from './path.js';
import type { MemoryDecl, MemoryRunContext } from './types.js';

function decl(overrides: Partial<MemoryDecl> = {}): MemoryDecl {
  return {
    name: 'history',
    scope: 'schedule',
    strategy: 'sliding_window',
    size: 30,
    ...overrides,
  } as MemoryDecl;
}

function ctx(overrides: Partial<MemoryRunContext> = {}): MemoryRunContext {
  return {
    input: 'hello',
    sessionId: 'session_abc',
    keys: {},
    runsRoot: '/tmp/runs',
    ...overrides,
  };
}

describe('memory scope :schedule path resolution (RED-305)', () => {
  it('keys the bucket by the scheduleId from the run context', () => {
    const path = resolveBucketPath(
      decl(),
      ctx({ scheduleId: 'morning_digest.analyze.daily' }),
    );
    expect(path).toBe(
      '/tmp/runs/memory/schedule/morning_digest.analyze.daily/history.sqlite',
    );
  });

  it('throws a clear error when scope: :schedule lacks a scheduleId', () => {
    expect(() => resolveBucketPath(decl(), ctx())).toThrow(
      /requires a scheduled fire/,
    );
  });

  it('different schedule ids route to different buckets (isolation)', () => {
    const a = resolveBucketPath(
      decl(),
      ctx({ scheduleId: 'extractor.analyze.morning' }),
    );
    const b = resolveBucketPath(
      decl(),
      ctx({ scheduleId: 'extractor.analyze.evening' }),
    );
    expect(a).not.toBe(b);
    expect(a).toContain('/schedule/extractor.analyze.morning/');
    expect(b).toContain('/schedule/extractor.analyze.evening/');
  });

  it('session scope still routes to sessionId (no regression)', () => {
    const path = resolveBucketPath(
      decl({ scope: 'session' }),
      ctx({ sessionId: 'session_xyz' }),
    );
    expect(path).toBe('/tmp/runs/memory/session/session_xyz/history.sqlite');
  });

  it('global scope still routes to `_` (no regression)', () => {
    const path = resolveBucketPath(
      { name: 'x', scope: 'global', strategy: 'log' } as MemoryDecl,
      ctx(),
    );
    expect(path).toBe('/tmp/runs/memory/global/_/x.sqlite');
  });
});
