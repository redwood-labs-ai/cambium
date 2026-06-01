import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  classNameToFileBase,
  findRetroAgentFile,
  buildRetroContext,
  applyRetroWrites,
  resolveDefaultCli,
  sanitizeRetroContent,
  MAX_RETRO_CONTENT_BYTES,
} from './retro-agent.js';
import { SqliteMemoryBackend } from './backend.js';

describe('classNameToFileBase (RED-215 phase 4)', () => {
  it('snake_cases a multi-word CamelCase name', () => {
    expect(classNameToFileBase('SupportMemoryAgent')).toBe('support_memory_agent');
  });

  it('handles single-word names', () => {
    expect(classNameToFileBase('Agent')).toBe('agent');
  });

  it('handles mid-word numerics', () => {
    expect(classNameToFileBase('V2Agent')).toBe('v2_agent');
    expect(classNameToFileBase('HTMLParser')).toBe('htmlparser'); // acronym joining — acceptable for now
  });

  it('is idempotent on already-snake_case names', () => {
    expect(classNameToFileBase('already_snake')).toBe('already_snake');
  });
});

describe('findRetroAgentFile (RED-215 phase 4)', () => {
  it('finds a file in the primary gen\'s sibling directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-find-'));
    writeFileSync(join(dir, 'support_memory_agent.cmb.rb'), '# stub');
    const primary = join(dir, 'primary.cmb.rb');
    const found = findRetroAgentFile('SupportMemoryAgent', primary);
    expect(found).toBe(join(dir, 'support_memory_agent.cmb.rb'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the workspace default (anchored via import.meta.url, not cwd)', () => {
    // The workspace has support_memory_agent.cmb.rb under
    // packages/cambium/app/gens (seeded in phase 4). A primary living
    // elsewhere with no sibling triggers the fallback. The returned
    // path is absolute because it's anchored at WORKSPACE_ROOT, not
    // process.cwd() — verified by checking both the suffix and that
    // the path starts with '/' (POSIX) or a drive-letter prefix.
    const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-fallback-'));
    const primary = join(dir, 'primary.cmb.rb');
    const found = findRetroAgentFile('SupportMemoryAgent', primary);
    expect(found).not.toBeNull();
    expect(found!.endsWith(join('packages', 'cambium', 'app', 'gens', 'support_memory_agent.cmb.rb'))).toBe(true);
    expect(found!.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(found!)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when neither candidate exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-miss-'));
    const primary = join(dir, 'primary.cmb.rb');
    expect(findRetroAgentFile('SomeBogusAgentName', primary)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveDefaultCli (RED-380)', () => {
  const ORIGINAL_CWD_CLI = process.env.CAMBIUM_CLI;

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_CWD_CLI === undefined) delete process.env.CAMBIUM_CLI;
    else process.env.CAMBIUM_CLI = ORIGINAL_CWD_CLI;
  });

  it('an explicit override wins outright (highest precedence)', () => {
    process.env.CAMBIUM_CLI = '/env/should/be/ignored/cambium.mjs';
    expect(resolveDefaultCli('/explicit/override/cambium.mjs')).toBe(
      '/explicit/override/cambium.mjs',
    );
  });

  it('falls back to CAMBIUM_CLI env when no override is given', () => {
    process.env.CAMBIUM_CLI = '/operator/escape/hatch/cambium.mjs';
    expect(resolveDefaultCli()).toBe('/operator/escape/hatch/cambium.mjs');
  });

  it('ignores a blank/whitespace override and env value', () => {
    process.env.CAMBIUM_CLI = '   ';
    // No override, blank env → falls through to module-location resolution,
    // which finds the in-tree cli/cambium.mjs (tests run from the monorepo).
    const resolved = resolveDefaultCli('   ');
    expect(resolved).not.toBeNull();
    expect(resolved!.endsWith(join('cli', 'cambium.mjs'))).toBe(true);
  });

  it('resolves the CLI independent of process.cwd() — the RED-380 fix', () => {
    // Simulate an engine-mode / external-consumer cwd: process.cwd()
    // points at some unrelated checkout, NOT the cambium monorepo root.
    // The pre-RED-380 code spawned the cwd-relative literal 'cli/cambium.mjs'
    // and ENOENT'd here; the module-location resolution must still succeed.
    delete process.env.CAMBIUM_CLI;
    const foreignCwd = mkdtempSync(join(tmpdir(), 'cambium-foreign-cwd-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(foreignCwd);
    try {
      const resolved = resolveDefaultCli();
      expect(resolved).not.toBeNull();
      // Anchored at the module location, so it's absolute and lands on
      // an actual cli/cambium.mjs — never under the foreign cwd.
      expect(resolved!.endsWith(join('cli', 'cambium.mjs'))).toBe(true);
      expect(resolved!.startsWith(foreignCwd + sep)).toBe(false);
      expect(resolved!.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resolved!)).toBe(true);
    } finally {
      cwdSpy.mockRestore();
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });
});

describe('buildRetroContext (RED-215 phase 4)', () => {
  it('packs input, output, and trace into one JSON payload', () => {
    const ctx = buildRetroContext('the document', { answer: 42 }, { steps: [{ type: 'Generate' }] });
    const parsed = JSON.parse(ctx);
    expect(parsed.primary_input).toBe('the document');
    expect(parsed.primary_output.answer).toBe(42);
    expect(parsed.primary_trace.steps[0].type).toBe('Generate');
  });
});

describe('applyRetroWrites (RED-215 phase 4)', () => {
  async function freshBackend(name = 'test'): Promise<{ backend: SqliteMemoryBackend; path: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-apply-'));
    const path = join(dir, `${name}.sqlite`);
    return { backend: await SqliteMemoryBackend.open(path), path };
  }

  it('applies a write to the matching backend and tags written_by', async () => {
    const { backend, path } = await freshBackend('conversation');
    const backends = new Map([['conversation', backend]]);
    const { applied, dropped } = applyRetroWrites(
      [{ memory: 'conversation', content: 'remembered note' }],
      backends,
      'SupportMemoryAgent',
    );
    expect(applied).toHaveLength(1);
    expect(applied[0].memory).toBe('conversation');
    expect(dropped).toHaveLength(0);

    const [entry] = backend.readRecent(1);
    expect(entry.written_by).toBe('agent:SupportMemoryAgent');
    expect(entry.content).toBe('remembered note');
    backend.close();
    rmSync(path, { force: true });
  });

  it('drops writes naming a memory slot not on the primary (best-effort)', async () => {
    const { backend, path } = await freshBackend('conversation');
    const backends = new Map([['conversation', backend]]);
    const { applied, dropped } = applyRetroWrites(
      [
        { memory: 'conversation', content: 'ok' },
        { memory: 'nonexistent_slot', content: 'will be dropped' },
      ],
      backends,
      'SomeAgent',
    );
    expect(applied).toHaveLength(1);
    expect(dropped).toEqual([
      { memory: 'nonexistent_slot', reason: 'no matching memory decl on primary' },
    ]);
    backend.close();
    rmSync(path, { force: true });
  });

  // Security finding (MEDIUM): defense-in-depth against prompt-injected
  // retro agents flooding memory or smuggling control chars.
  it('truncates content over MAX_RETRO_CONTENT_BYTES and flags truncated: true', async () => {
    const { backend, path } = await freshBackend('conversation');
    const backends = new Map([['conversation', backend]]);
    const big = 'a'.repeat(MAX_RETRO_CONTENT_BYTES + 500);
    const { applied } = applyRetroWrites(
      [{ memory: 'conversation', content: big }],
      backends,
      'SomeAgent',
    );
    expect(applied).toHaveLength(1);
    expect(applied[0].truncated).toBe(true);
    expect(applied[0].bytes).toBeLessThanOrEqual(MAX_RETRO_CONTENT_BYTES + 10); // +ellipsis bytes
    backend.close();
    rmSync(path, { force: true });
  });

  it('strips C0/DEL control characters from content before committing', async () => {
    const { backend, path } = await freshBackend('conversation');
    const backends = new Map([['conversation', backend]]);
    applyRetroWrites(
      [{ memory: 'conversation', content: 'hello\x00world\x07bell\x7Fdel' }],
      backends,
      'SomeAgent',
    );
    const [entry] = backend.readRecent(1);
    expect(entry.content).toBe('helloworldbelldel');
    backend.close();
    rmSync(path, { force: true });
  });

  it('preserves newlines in sanitized content (phase-3 collapse handles them at read time)', () => {
    const { content } = sanitizeRetroContent('line1\nline2');
    expect(content).toBe('line1\nline2');
  });

  it('drops malformed entries (missing string fields) without crashing', async () => {
    const { backend, path } = await freshBackend('conversation');
    const backends = new Map([['conversation', backend]]);
    const { applied, dropped } = applyRetroWrites(
      [
        { memory: 'conversation', content: 'ok' },
        { memory: 123 as any, content: 'bad memory type' },
        { memory: 'conversation', content: null as any },
      ],
      backends,
      'SomeAgent',
    );
    expect(applied).toHaveLength(1);
    expect(dropped).toHaveLength(2);
    expect(dropped[0].reason).toBe('malformed entry');
    backend.close();
    rmSync(path, { force: true });
  });
});
