import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * RED-215 phase 5: end-to-end :semantic memory.
 *
 * Spawns the CLI twice with the same session id. First run writes an
 * entry with both content and its mock embedding into `entries` +
 * `entries_vec`. Second run embeds the (same) input, runs vec-search,
 * finds the prior entry, and injects it into the Memory block.
 *
 * Uses the mock embed provider (SHA-256-seeded vectors) so the test
 * is deterministic and doesn't depend on any live embedding backend.
 */

const FIXTURE_ARG = 'packages/cambium/examples/fixtures/incident.txt';

describe('semantic memory runtime — spawn cambium run with --mock', () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const id of sessionIds) {
      rmSync(join('runs', 'memory', 'session', id), { recursive: true, force: true });
    }
    sessionIds.length = 0;
  });

  function writeGen(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-sem-'));
    const path = join(dir, 'primary.cmb.rb');
    writeFileSync(path, body.trim());
    return path;
  }

  function runCli(
    genPath: string,
    sessionId: string,
  ): { status: number | null; stderr: string; tracePath: string; outPath: string } {
    const runDir = mkdtempSync(join(tmpdir(), 'cambium-sem-run-'));
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
      tracePath,
      outPath,
    };
  }

  it('writes + round-trip reads a semantic entry via vec search', () => {
    const id = 'sem-' + randomUUID();
    sessionIds.push(id);

    const gen = writeGen(`
class SemanticGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en"

  def analyze(x)
    generate "Analyze: #{x}" do
      returns AnalysisReport
    end
  end
end
`);

    // --- First run: bucket empty → no semantic read, but write lands ---
    const run1 = runCli(gen, id);
    expect([0, 1]).toContain(run1.status);

    const trace1 = JSON.parse(readFileSync(run1.tracePath, 'utf8'));
    const read1 = trace1.steps.find((s: any) => s.type === 'memory.read');
    expect(read1.meta.note).toMatch(/bucket empty/);

    const write1 = trace1.steps.find((s: any) => s.type === 'memory.write');
    expect(write1.meta.strategy).toBe('semantic');
    expect(write1.meta.embed_model).toBe('omlx:bge-small-en');
    expect(write1.meta.embed_dim).toBe(384);

    // Bucket is now on-disk with the vec table populated.
    const bucket = join('runs', 'memory', 'session', id, 'facts.sqlite');
    expect(existsSync(bucket)).toBe(true);
    // Load vec0 on the test's read-back instance too — the virtual
    // table's metadata is in the bucket file, but the module itself is
    // loaded per-connection.
    const db = new Database(bucket, { readonly: true });
    sqliteVec.load(db);
    const entryCount = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as any;
    const vecCount = db.prepare('SELECT COUNT(*) AS n FROM entries_vec').get() as any;
    expect(entryCount.n).toBe(1);
    expect(vecCount.n).toBe(1);
    const meta = db.prepare('SELECT key, value FROM meta').all() as any[];
    expect(meta.find(m => m.key === 'embed_model').value).toBe('omlx:bge-small-en');
    db.close();

    // --- Second run: identical input → mock embed reproduces → knn returns prior entry ---
    const run2 = runCli(gen, id);
    if (!existsSync(run2.tracePath)) {
      throw new Error(`run2 produced no trace. status=${run2.status}\nstderr:\n${run2.stderr}`);
    }

    const trace2 = JSON.parse(readFileSync(run2.tracePath, 'utf8'));
    const read2 = trace2.steps.find((s: any) => s.type === 'memory.read');
    expect(read2.meta.strategy).toBe('semantic');
    expect(read2.meta.hits).toBe(1);
    expect(read2.meta.k).toBe(3);       // requested top_k
    expect(read2.meta.embed_dim).toBe(384);
  }, 90_000);

  it('refuses to open a bucket with a different embed model', () => {
    // Run once with model A, then once with model B → second run errors
    // at initSemantic with a clear "cannot now use" message. Primary
    // exits non-zero because commit fails — memory errors during write
    // ARE surfaced (unlike retro-agent failures which are best-effort;
    // trivial-default-writer errors during main commit propagate).
    const id = 'sem-modelchange-' + randomUUID();
    sessionIds.push(id);

    const genA = writeGen(`
class ModelAGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:bge-small-en"
  def analyze(x)
    generate "X: #{x}" do
      returns AnalysisReport
    end
  end
end
`);
    const r1 = runCli(genA, id);
    expect([0, 1]).toContain(r1.status);

    const genB = writeGen(`
class ModelBGen < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport
  memory :facts, strategy: :semantic, top_k: 3, embed: "omlx:completely-different"
  def analyze(x)
    generate "X: #{x}" do
      returns AnalysisReport
    end
  end
end
`);
    const r2 = runCli(genB, id);
    // The second run exits non-zero because a thrown commit error
    // is not best-effort — model pinning is a correctness invariant.
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toMatch(/cannot now use|embed_model/);
  }, 90_000);
});
