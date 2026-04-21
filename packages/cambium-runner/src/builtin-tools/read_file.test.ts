import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './read_file.tool.js';
import type { ToolContext } from '../tools/tool-context.js';

function makeCtxWithRoots(...roots: string[]): ToolContext {
  return {
    toolName: 'read_file',
    fetch: () => Promise.reject(new Error('no network')),
    filesystemPolicy: { roots },
  };
}

describe('read_file — filesystem roots enforcement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-rf-'));
  const allowed = join(dir, 'allowed');
  const other = join(dir, 'other');
  mkdirSync(allowed);
  mkdirSync(other);
  writeFileSync(join(allowed, 'hello.txt'), 'hello world\nline two\n');
  writeFileSync(join(other, 'secret.txt'), 'secret');

  it('reads a file within the declared root', () => {
    const ctx = makeCtxWithRoots(allowed);
    const out = execute({ path: join(allowed, 'hello.txt') }, ctx);
    expect(out.content).toContain('hello world');
  });

  it('denies a file outside the declared root', () => {
    const ctx = makeCtxWithRoots(allowed);
    expect(() => execute({ path: join(other, 'secret.txt') }, ctx)).toThrow(
      /outside the declared filesystem roots/,
    );
  });

  it('denies path traversal that escapes the root', () => {
    const ctx = makeCtxWithRoots(allowed);
    expect(() =>
      execute({ path: join(allowed, '..', 'other', 'secret.txt') }, ctx),
    ).toThrow(/outside the declared filesystem roots/);
  });

  it('denies symlink escaping the root', () => {
    const linkPath = join(allowed, 'escape.txt');
    symlinkSync(join(other, 'secret.txt'), linkPath);
    const ctx = makeCtxWithRoots(allowed);
    expect(() => execute({ path: linkPath }, ctx)).toThrow(
      /outside the declared filesystem roots/,
    );
  });

  it('allows access when no filesystemPolicy is set (no-ctx call)', () => {
    // Direct call without ctx — roots are not enforced, existing BLOCKED_PATHS
    // still apply. This is the unit-test / direct-call path.
    const out = execute({ path: join(other, 'secret.txt') });
    expect(out.content).toBe('secret');
  });

  it('allows access when roots list is empty (policy present but unconstrained)', () => {
    // Empty roots = no positive constraint declared; treat as unconstrained.
    const ctx = makeCtxWithRoots();
    const out = execute({ path: join(other, 'secret.txt') }, ctx);
    expect(out.content).toBe('secret');
  });

  it('accepts a relative root by resolving it', () => {
    const ctx = makeCtxWithRoots(resolve(allowed));
    const out = execute({ path: join(allowed, 'hello.txt') }, ctx);
    expect(out.content).toContain('hello world');
  });
});
