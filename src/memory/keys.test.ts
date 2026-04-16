import { describe, it, expect, vi } from 'vitest';
import { parseMemoryKeys, resolveSessionId } from './keys.js';

describe('parseMemoryKeys (RED-215 phase 3)', () => {
  it('parses a single name=value pair', () => {
    expect(parseMemoryKeys(['user_id=alice'])).toEqual({ user_id: 'alice' });
  });

  it('parses multiple pairs', () => {
    expect(parseMemoryKeys(['user_id=alice', 'team_id=redwood'])).toEqual({
      user_id: 'alice', team_id: 'redwood',
    });
  });

  it('rejects malformed entries', () => {
    expect(() => parseMemoryKeys(['malformed']))
      .toThrow(/--memory-key must be <name>=<value>/);
    expect(() => parseMemoryKeys(['=value']))
      .toThrow(/--memory-key must be <name>=<value>/);
  });

  it('rejects values that could escape a directory', () => {
    expect(() => parseMemoryKeys(['user_id=../escape']))
      .toThrow(/must match/);
    expect(() => parseMemoryKeys(['user_id=with space']))
      .toThrow(/must match/);
    expect(() => parseMemoryKeys(['user_id=slash/bad']))
      .toThrow(/must match/);
  });

  it('accepts dashes and underscores in values', () => {
    expect(parseMemoryKeys(['user_id=ada-1_test'])).toEqual({ user_id: 'ada-1_test' });
  });

  it('rejects a value containing = (first = separates name/value, SAFE_VALUE_RE forbids the rest)', () => {
    // The split regex consumes only the first `=`, so a value of `abc=def`
    // would be passed through; SAFE_VALUE_RE then rejects it because `=` is
    // not in [a-zA-Z0-9_\-]. This keeps the opt-in strict.
    expect(() => parseMemoryKeys(['token=abc=def'])).toThrow(/must match/);
  });

  it('rejects values longer than 128 characters (DoS-via-path-length guard)', () => {
    expect(() => parseMemoryKeys(['user_id=' + 'a'.repeat(200)]))
      .toThrow(/exceeds 128 characters/);
  });
});

describe('resolveSessionId (RED-215 phase 3)', () => {
  it('uses CAMBIUM_SESSION_ID when set', () => {
    const id = resolveSessionId({ CAMBIUM_SESSION_ID: 'fixed-id' } as any, false);
    expect(id).toBe('fixed-id');
  });

  it('auto-generates a UUID when CAMBIUM_SESSION_ID is unset', () => {
    const id = resolveSessionId({} as any, false);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('echoes the generated id to stderr when echo=true', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const id = resolveSessionId({} as any, true);
    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(written).toContain(id);
    expect(written).toContain('CAMBIUM_SESSION_ID=');
    writeSpy.mockRestore();
  });

  it('does NOT echo when CAMBIUM_SESSION_ID was already set', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resolveSessionId({ CAMBIUM_SESSION_ID: 'fixed' } as any, true);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  // Security finding (HIGH): CAMBIUM_SESSION_ID flows directly into
  // node:path.join as a directory segment. node:path doesn't reject `..`
  // traversal; the validator must.
  it('rejects CAMBIUM_SESSION_ID with path-traversal bytes', () => {
    expect(() => resolveSessionId({ CAMBIUM_SESSION_ID: '../../etc' } as any, false))
      .toThrow(/must match/);
    expect(() => resolveSessionId({ CAMBIUM_SESSION_ID: 'slash/bad' } as any, false))
      .toThrow(/must match/);
    expect(() => resolveSessionId({ CAMBIUM_SESSION_ID: '' } as any, false))
      // empty string hits the fromEnv check (trim returns '') — auto-gen path
      .not.toThrow();
  });

  it('rejects absurdly long session ids (DoS-via-path-length guard)', () => {
    expect(() => resolveSessionId({ CAMBIUM_SESSION_ID: 'a'.repeat(200) } as any, false))
      .toThrow(/exceeds 128 characters/);
  });
});
