/**
 * RED-287: engine-folder resolution tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEngineDir } from './engine-root.js';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-engineroot-')));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe('resolveEngineDir', () => {
  it('returns the engine dir when the sentinel sits next to the source file', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    writeFileSync(join(scratch, 'summarizer.cmb.rb'), '# gen');
    const r = resolveEngineDir(join(scratch, 'summarizer.cmb.rb'));
    expect(r).toBe(scratch);
  });

  it('walks up to find the sentinel from a nested sibling', () => {
    // Pathological but worth pinning: source inside a sub-sub-dir of an
    // engine still resolves to the sentinel dir.
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const deep = join(scratch, 'nested', 'deeper');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'summarizer.cmb.rb'), '# gen');
    const r = resolveEngineDir(join(deep, 'summarizer.cmb.rb'));
    expect(r).toBe(scratch);
  });

  it('returns null when no sentinel is found up to fs root', () => {
    writeFileSync(join(scratch, 'summarizer.cmb.rb'), '# gen');
    const r = resolveEngineDir(join(scratch, 'summarizer.cmb.rb'));
    expect(r).toBeNull();
  });

  it('returns null when sourcePath is undefined / null / empty', () => {
    expect(resolveEngineDir(undefined)).toBeNull();
    expect(resolveEngineDir(null)).toBeNull();
    expect(resolveEngineDir('')).toBeNull();
  });

  it('handles relative paths by resolving to absolute first', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    writeFileSync(join(scratch, 'summarizer.cmb.rb'), '# gen');
    const prevCwd = process.cwd();
    try {
      process.chdir(scratch);
      const r = resolveEngineDir('summarizer.cmb.rb');
      expect(r).toBe(scratch);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
