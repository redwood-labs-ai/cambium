/**
 * RED-302: log plugin loader (app/logs/*.log.ts).
 *
 * Mirrors the RED-275 corrector app-loader test shape: name regex,
 * realpath escape guard, export-matches-basename.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAppLogSinks } from './plugin-loader.js';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red302-logs-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function writeLogSink(name: string, body?: string): string {
  const dir = join(scratch, 'app', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.log.ts`);
  writeFileSync(
    file,
    body ??
      `export const ${name} = async (event: any, dest: any) => { /* noop */ };`,
  );
  return file;
}

describe('loadAppLogSinks (RED-302)', () => {
  it('returns empty when the directory does not exist', async () => {
    const result = await loadAppLogSinks(scratch);
    expect(result.sinks).toEqual({});
    expect(result.loadedFiles).toEqual([]);
  });

  it('discovers a log sink matching the file basename', async () => {
    writeLogSink('honeycomb');
    const result = await loadAppLogSinks(scratch);
    expect(Object.keys(result.sinks)).toEqual(['honeycomb']);
    expect(typeof result.sinks.honeycomb).toBe('function');
  });

  it('loads multiple sinks', async () => {
    writeLogSink('one');
    writeLogSink('two');
    const result = await loadAppLogSinks(scratch);
    expect(new Set(Object.keys(result.sinks))).toEqual(new Set(['one', 'two']));
  });

  it('rejects a file whose basename fails the name regex', async () => {
    const dir = join(scratch, 'app', 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'BadName.log.ts'), 'export const BadName = async () => {};');
    await expect(loadAppLogSinks(scratch)).rejects.toThrow(/must match/);
  });

  it('throws when the module does not export a function matching the basename', async () => {
    writeLogSink('broken', 'export const something_else = async () => {};');
    await expect(loadAppLogSinks(scratch)).rejects.toThrow(
      /must export a function named "broken"/,
    );
  });

  it('engine-mode: scans the engineDir directly', async () => {
    const engineDir = join(scratch, 'my_engine');
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(
      join(engineDir, 'engine_sink.log.ts'),
      'export const engine_sink = async () => {};',
    );
    const result = await loadAppLogSinks(scratch, { engineDir });
    expect(Object.keys(result.sinks)).toEqual(['engine_sink']);
  });

  it('rejects a symlink that escapes the plugins directory', async () => {
    const dir = join(scratch, 'app', 'logs');
    mkdirSync(dir, { recursive: true });
    const outside = join(scratch, 'outside.log.ts');
    writeFileSync(outside, 'export const outside = async () => {};');
    symlinkSync(outside, join(dir, 'outside.log.ts'));
    await expect(loadAppLogSinks(scratch)).rejects.toThrow(/resolves outside/);
  });
});
