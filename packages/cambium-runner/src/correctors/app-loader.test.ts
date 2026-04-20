import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppCorrectors } from './app-loader.js';

describe('loadAppCorrectors (RED-275)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-app-correctors-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(rel: string, body: string) {
    const full = join(tmp, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
    return full;
  }

  const GOOD_BODY = `
export const my_corrector = (data, context) => ({
  corrected: false,
  output: data,
  issues: [],
});
`;

  it('returns an empty map when app/correctors/ does not exist', async () => {
    const res = await loadAppCorrectors(tmp);
    expect(res.correctors).toEqual({});
    expect(res.loadedFiles).toEqual([]);
  });

  it('loads a valid corrector', async () => {
    writeFile('app/correctors/my_corrector.corrector.ts', GOOD_BODY);
    const res = await loadAppCorrectors(tmp);
    expect(Object.keys(res.correctors)).toEqual(['my_corrector']);
    expect(typeof res.correctors.my_corrector).toBe('function');
    expect(res.loadedFiles).toHaveLength(1);
  });

  it('loads multiple correctors', async () => {
    writeFile('app/correctors/a.corrector.ts', GOOD_BODY.replace('my_corrector', 'a'));
    writeFile('app/correctors/b.corrector.ts', GOOD_BODY.replace('my_corrector', 'b'));
    const res = await loadAppCorrectors(tmp);
    expect(new Set(Object.keys(res.correctors))).toEqual(new Set(['a', 'b']));
  });

  it('ignores non-*.corrector.ts files in app/correctors/', async () => {
    writeFile('app/correctors/README.md', '# not a corrector');
    writeFile('app/correctors/helpers.ts', '// not a corrector either');
    writeFile('app/correctors/ok.corrector.ts', GOOD_BODY.replace('my_corrector', 'ok'));
    const res = await loadAppCorrectors(tmp);
    expect(Object.keys(res.correctors)).toEqual(['ok']);
  });

  it('rejects uppercase names', async () => {
    writeFile('app/correctors/BadName.corrector.ts', GOOD_BODY);
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(/must match/);
  });

  it('rejects names starting with a digit', async () => {
    writeFile('app/correctors/1bad.corrector.ts', GOOD_BODY);
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(/must match/);
  });

  it('rejects names with a hyphen', async () => {
    writeFile('app/correctors/has-hyphen.corrector.ts', GOOD_BODY);
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(/must match/);
  });

  it('rejects a file whose export name does not match the basename', async () => {
    writeFile(
      'app/correctors/expected_name.corrector.ts',
      `export const actual_name = (data) => ({ corrected: false, output: data, issues: [] });`,
    );
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(
      /must export a function named "expected_name"/,
    );
  });

  it('rejects a file whose export is not a function', async () => {
    writeFile(
      'app/correctors/not_a_fn.corrector.ts',
      `export const not_a_fn = { corrected: false };`,
    );
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(
      /must export a function named "not_a_fn"/,
    );
  });

  it('rejects a symlinked file that escapes app/correctors/', async () => {
    // Target lives outside the correctors dir; symlink points to it.
    mkdirSync(join(tmp, 'outside'), { recursive: true });
    writeFileSync(join(tmp, 'outside', 'evil.ts'), GOOD_BODY.replace('my_corrector', 'evil'));
    mkdirSync(join(tmp, 'app', 'correctors'), { recursive: true });
    symlinkSync(
      join(tmp, 'outside', 'evil.ts'),
      join(tmp, 'app', 'correctors', 'evil.corrector.ts'),
    );
    await expect(loadAppCorrectors(tmp)).rejects.toThrow(/resolves outside/);
  });

  it('throws if genfileDir is not absolute', async () => {
    await expect(loadAppCorrectors('relative/path')).rejects.toThrow(/must be absolute/);
  });
});
