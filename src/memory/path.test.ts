import { describe, it, expect } from 'vitest';
import { resolveBucketPath } from './path.js';
import type { MemoryDecl, MemoryRunContext } from './types.js';

function ctx(over: Partial<MemoryRunContext> = {}): MemoryRunContext {
  return {
    input: 'hello',
    sessionId: 'sess-42',
    keys: {},
    runsRoot: '/runs',
    ...over,
  };
}

describe('resolveBucketPath (RED-215 phase 3)', () => {
  it('routes :session scope to runs/memory/session/<sessionId>/<name>.sqlite', () => {
    const decl: MemoryDecl = { name: 'conversation', scope: 'session', strategy: 'sliding_window', size: 10 };
    expect(resolveBucketPath(decl, ctx())).toBe('/runs/memory/session/sess-42/conversation.sqlite');
  });

  it('routes :global with no keyed_by to runs/memory/global/_/<name>.sqlite', () => {
    const decl: MemoryDecl = { name: 'activity', scope: 'global', strategy: 'log' };
    expect(resolveBucketPath(decl, ctx())).toBe('/runs/memory/global/_/activity.sqlite');
  });

  it('routes :global with keyed_by to runs/memory/global/<keyval>/<name>.sqlite', () => {
    const decl: MemoryDecl = {
      name: 'prefs', scope: 'global', strategy: 'log', keyed_by: 'user_id',
    };
    expect(resolveBucketPath(decl, ctx({ keys: { user_id: 'ada' } })))
      .toBe('/runs/memory/global/ada/prefs.sqlite');
  });

  it('routes a named pool to runs/memory/<pool>/<keyval>/<name>.sqlite', () => {
    const decl: MemoryDecl = {
      name: 'facts', scope: 'support_team', strategy: 'sliding_window',
      keyed_by: 'team_id', size: 5,
    };
    expect(resolveBucketPath(decl, ctx({ keys: { team_id: 'redwood' } })))
      .toBe('/runs/memory/support_team/redwood/facts.sqlite');
  });

  it('errors clearly when a keyed_by key has no --memory-key value', () => {
    const decl: MemoryDecl = {
      name: 'facts', scope: 'support_team', strategy: 'sliding_window',
      keyed_by: 'team_id', size: 5,
    };
    expect(() => resolveBucketPath(decl, ctx()))
      .toThrow(/needs --memory-key team_id=<value>/);
  });

  it('errors when a non-session non-global scope has no keyed_by', () => {
    const decl: MemoryDecl = {
      name: 'orphan', scope: 'rogue_pool', strategy: 'log',
    };
    expect(() => resolveBucketPath(decl, ctx()))
      .toThrow(/no keyed_by/);
  });
});
