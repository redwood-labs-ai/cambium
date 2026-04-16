import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * RED-215 phase 4: retro memory-agent runtime.
 *
 * Spawns a primary gen with `write_memory_via :SupportMemoryAgent` and
 * verifies the agent is invoked end-to-end: its write lands in the
 * primary's bucket with `written_by: 'agent:SupportMemoryAgent'`, and
 * dropped writes (targeting an undeclared slot) are surfaced in trace
 * rather than silently discarded.
 *
 * Complements the phase-3 memory_runtime tests — those exercise the
 * trivial-default writer; phase 4 replaces the deferred stub with real
 * retro-agent invocation.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt';

describe('retro memory agent — spawn cambium run with --mock', () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const id of sessionIds) {
      rmSync(join('runs', 'memory', 'session', id), { recursive: true, force: true });
    }
    sessionIds.length = 0;
  });

  function writeGen(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-'));
    const path = join(dir, 'primary.cmb.rb');
    writeFileSync(path, body.trim());
    return path;
  }

  function runCli(
    genPath: string,
    sessionId: string,
  ): { status: number | null; stderr: string; stdout: string; tracePath: string; outPath: string } {
    const runDir = mkdtempSync(join(tmpdir(), 'cambium-retrorun-'));
    const tracePath = join(runDir, 'trace.json');
    const outPath = join(runDir, 'output.json');
    const result = spawnSync(
      'node',
      ['cli/cambium.mjs', 'run', genPath,
        '--method', 'analyze', '--arg', FIXTURE_ARG,
        '--trace', tracePath, '--out', outPath, '--mock'],
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

  it('invokes the retro agent, lands one agent-tagged write, traces dropped writes', () => {
    // Primary declares `memory :conversation` — matches the conventional
    // name the mockGenerate retro-agent output targets. We do NOT declare
    // :facts, so a hypothetical write to a non-existent slot would drop.
    const id = 'retro-' + randomUUID();
    sessionIds.push(id);

    const gen = writeGen(`
class RetroPrimaryGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 3
  write_memory_via :SupportMemoryAgent

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);

    const run = runCli(gen, id);
    expect([0, 1]).toContain(run.status);

    const bucket = join('runs', 'memory', 'session', id, 'conversation.sqlite');
    expect(existsSync(bucket)).toBe(true);

    // The agent's write is visible on-disk and tagged with `agent:…`.
    const db = new Database(bucket, { readonly: true });
    const rows = db.prepare('SELECT * FROM entries').all() as any[];
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].written_by).toBe('agent:SupportMemoryAgent');
    expect(rows[0].content).toContain('mock retro agent note');

    // Trace records the agent write with the right metadata shape.
    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'));
    const agentWrite = trace.steps.find(
      (s: any) => s.id === 'memory_write_conversation_agent',
    );
    expect(agentWrite).toBeDefined();
    expect(agentWrite.meta.written_by).toBe('agent:SupportMemoryAgent');
    expect(agentWrite.meta.entry_id).toBe(1);
  }, 90_000);

  it('traces the failure (agent not found) without breaking the primary', () => {
    const id = 'retro-missing-' + randomUUID();
    sessionIds.push(id);

    const gen = writeGen(`
class MissingAgentGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :conversation, strategy: :sliding_window, size: 3
  write_memory_via :NoSuchAgentClass

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);

    const run = runCli(gen, id);
    expect([0, 1]).toContain(run.status);

    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'));
    const notFound = trace.steps.find(
      (s: any) => s.id === 'memory_write_agent_not_found',
    );
    expect(notFound).toBeDefined();
    expect(notFound.ok).toBe(false);
    expect(notFound.errors[0].message).toMatch(/write_memory_via :NoSuchAgentClass/);

    // The bucket was opened for reads (at the start of the run) but has
    // zero agent writes committed — confirming the primary didn't fall
    // through to the trivial-default writer either.
    const bucket = join('runs', 'memory', 'session', id, 'conversation.sqlite');
    expect(existsSync(bucket)).toBe(true);
    const db = new Database(bucket, { readonly: true });
    const rows = db.prepare('SELECT * FROM entries').all() as any[];
    db.close();
    expect(rows).toHaveLength(0);
  }, 90_000);

  it('drops writes targeting an undeclared memory slot (best-effort, traced)', () => {
    // Set up: primary declares `memory :other_slot`, but the mock retro
    // agent writes to `memory: 'conversation'`. That name is unknown
    // on this primary → drop with trace. Primary runs clean regardless.
    const id = 'retro-drop-' + randomUUID();
    sessionIds.push(id);

    const gen = writeGen(`
class DropsGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :other_slot, strategy: :log
  write_memory_via :SupportMemoryAgent

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);

    const run = runCli(gen, id);
    expect([0, 1]).toContain(run.status);

    const trace = JSON.parse(readFileSync(run.tracePath, 'utf8'));
    const dropped = trace.steps.find((s: any) => s.id === 'memory_write_agent_dropped');
    expect(dropped).toBeDefined();
    expect(dropped.meta.dropped[0]).toEqual({
      memory: 'conversation', reason: 'no matching memory decl on primary',
    });

    // No applied writes for this run.
    const applied = trace.steps.filter(
      (s: any) => typeof s.id === 'string' && s.id.endsWith('_agent') && s.meta?.written_by?.startsWith('agent:'),
    );
    expect(applied).toHaveLength(0);

    // The declared slot (other_slot) is intact but empty.
    const bucket = join('runs', 'memory', 'session', id, 'other_slot.sqlite');
    expect(existsSync(bucket)).toBe(true);
    const db = new Database(bucket, { readonly: true });
    const rows = db.prepare('SELECT * FROM entries').all() as any[];
    db.close();
    expect(rows).toHaveLength(0);
  }, 90_000);
});
