import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * RED-215 phase 3: end-to-end memory. Spawns the real CLI twice with
 * the same session id so the second run reads what the first one
 * wrote. Complements the compile-time tests from phase 2 — what phase
 * 3 adds is specifically the sqlite-vec-free bits (append + windowed
 * read + trace events + system-prompt injection).
 *
 * Buckets land under the real `runs/memory/` because that's where the
 * runner writes; we clean up per-session-id to keep the workspace tidy.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt';

describe('memory runtime — spawn cambium run with --mock', () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const id of sessionIds) {
      rmSync(join('runs', 'memory', 'session', id), { recursive: true, force: true });
    }
    sessionIds.length = 0;
  });

  function writeGen(body: string): { dir: string; genPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-memory-'));
    const genPath = join(dir, 'mem_gen.cmb.rb');
    // Use analyst.system.md so the gen has a valid system prompt lookup.
    const f = body.trim();
    require('node:fs').writeFileSync(genPath, f);
    return { dir, genPath };
  }

  function runCli(
    genPath: string,
    sessionId: string,
    extra: string[] = [],
  ): { status: number | null; stderr: string; stdout: string; tracePath: string; outPath: string } {
    const runDir = mkdtempSync(join(tmpdir(), 'cambium-memrun-'));
    const tracePath = join(runDir, 'trace.json');
    const outPath = join(runDir, 'output.json');
    const result = spawnSync(
      'node',
      ['cli/cambium.mjs', 'run', genPath,
        '--method', 'analyze', '--arg', FIXTURE_ARG,
        '--trace', tracePath, '--out', outPath, '--mock',
        ...extra],
      {
        encoding: 'utf8',
        env: { ...process.env, CAMBIUM_ALLOW_MOCK: '1', CAMBIUM_SESSION_ID: sessionId },
        cwd: process.cwd(),
      },
    );
    return {
      status: result.status,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
      tracePath,
      outPath,
    };
  }

  it('sliding_window :session memory — first run writes, second run reads', () => {
    const id = 'test-' + randomUUID();
    sessionIds.push(id);

    const { genPath } = writeGen(`
class MemRunGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 3

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);

    // --- First run ---
    const run1 = runCli(genPath, id);
    expect([0, 1]).toContain(run1.status);

    const bucket = join('runs', 'memory', 'session', id, 'conversation.sqlite');
    expect(existsSync(bucket)).toBe(true);

    const trace1 = JSON.parse(readFileSync(run1.tracePath, 'utf8'));
    const read1 = trace1.steps.find((s: any) => s.type === 'memory.read');
    const write1 = trace1.steps.find((s: any) => s.type === 'memory.write');
    expect(read1).toBeDefined();
    expect(read1.meta.hits).toBe(0);     // bucket was empty on first run
    expect(read1.meta.k).toBe(3);
    expect(write1).toBeDefined();
    expect(write1.meta.written_by).toBe('default');

    const db = new Database(bucket, { readonly: true });
    const rows = db.prepare('SELECT * FROM entries').all() as any[];
    db.close();
    expect(rows.length).toBe(1);
    const content = JSON.parse(rows[0].content);
    expect(content).toHaveProperty('input');
    expect(content).toHaveProperty('output');

    // --- Second run (same session id) ---
    const run2 = runCli(genPath, id);
    expect([0, 1]).toContain(run2.status);

    const trace2 = JSON.parse(readFileSync(run2.tracePath, 'utf8'));
    const read2 = trace2.steps.find((s: any) => s.type === 'memory.read');
    expect(read2.meta.hits).toBe(1); // the write from run1 is now readable
  }, 60_000);

  it(':log strategy writes but does not read-inject', () => {
    const id = 'test-' + randomUUID();
    sessionIds.push(id);

    const { genPath } = writeGen(`
class LogMemGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :activity, strategy: :log

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);
    const run = runCli(genPath, id);
    expect([0, 1]).toContain(run.status);

    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'));
    const read = trace.steps.find((s: any) => s.type === 'memory.read');
    expect(read).toBeDefined();
    expect(read.meta.k).toBe(0);
    expect(read.meta.hits).toBe(0);

    const write = trace.steps.find((s: any) => s.type === 'memory.write');
    expect(write).toBeDefined();
    expect(write.meta.written_by).toBe('default');
  }, 60_000);

  it('defers the trivial-default write when write_memory_via is declared', () => {
    const id = 'test-' + randomUUID();
    sessionIds.push(id);

    const { genPath } = writeGen(`
class DeferredWriteGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 2
  write_memory_via :SupportMemoryAgent

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);
    const run = runCli(genPath, id);
    expect([0, 1]).toContain(run.status);

    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'));
    const write = trace.steps.find((s: any) => s.type === 'memory.write');
    expect(write).toBeDefined();
    expect(write.id).toBe('memory_write_deferred');
    expect(write.meta.note).toMatch(/retro agent \(phase 4\)/);

    // And the bucket should still exist (read opened it) but have no rows.
    const bucket = join('runs', 'memory', 'session', id, 'conversation.sqlite');
    expect(existsSync(bucket)).toBe(true);
    const db = new Database(bucket, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as any;
    db.close();
    expect(rows.n).toBe(0);
  }, 60_000);
});
