/**
 * #195: `cambium run --ir <file.ir.json>` executes a precompiled artifact
 * directly — no Ruby spawn. DEC-006 (flag shape, --arg semantics,
 * refusals) and DEC-005 (anchoring on the artifact's own location, never
 * `ir.entry.source` or the caller's cwd).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env },
  });
}

/** Most-recently-created `run_*` directory under `runsDir` — run ids are
 *  timestamp-prefixed, so lexicographic order is chronological order. */
function latestRunDir(runsDir: string): string {
  const entries = readdirSync(runsDir).filter((e) => e.startsWith('run_')).sort();
  expect(entries.length).toBeGreaterThan(0);
  return join(runsDir, entries[entries.length - 1]);
}

const ECHO_GEN = `
class EchoGen < GenModel
  model "omlx:stub"
  system "inline"
  returns do
    field :summary, String
  end
  def analyze(document)
    generate "go" do
      with context: document
    end
  end
end
`.trim();

describe('#195: cambium run --ir', () => {
  describe('app-mode scratch', () => {
    let ws: string;
    beforeEach(() => {
      ws = mkdtempSync(join(tmpdir(), 'cambium-run-ir-app-'));
      mkdirSync(join(ws, 'app/gens'), { recursive: true });
      writeFileSync(join(ws, 'app/gens/echo_gen.cmb.rb'), ECHO_GEN);
      writeFileSync(join(ws, 'doc.txt'), 'hello from --arg\n');
      writeFileSync(join(ws, 'Genfile.toml'), `[package]\nname = "run-ir-app"\nversion = "0.0.0"\n`);
    });
    afterEach(() => {
      if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
    });

    it('compile --out-dir then run --ir --arg <file>: exit 0, runs/<id>/ir.json context equals the injected text', () => {
      const compileRes = runCli(['compile', '--out-dir', 'dist/ir'], ws);
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'dist/ir/echo_gen.ir.json');
      expect(existsSync(artifact)).toBe(true);

      const runRes = runCli(['run', '--ir', artifact, '--method', 'analyze', '--arg', 'doc.txt', '--mock'], ws);
      expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

      const runDir = latestRunDir(join(ws, 'runs'));
      const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
      expect(ir.context.document).toBe('hello from --arg\n');
    });

    it('omitted --arg keeps the compile-time bake-in (a from: gen, RED-383)', () => {
      // grounded_in's `from:` resolves relative paths from the GEN's own
      // directory, not the workspace root.
      writeFileSync(join(ws, 'app/gens/report.txt'), 'baked report body');
      writeFileSync(
        join(ws, 'app/gens/grounded_gen.cmb.rb'),
        `
class GroundedGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :report, from: "report.txt"
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim(),
      );
      const compileRes = runCli(['compile', '--out-dir', 'dist/ir'], ws);
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'dist/ir/grounded_gen.ir.json');

      const runRes = runCli(['run', '--ir', artifact, '--method', 'analyze', '--mock'], ws);
      expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

      const runDir = latestRunDir(join(ws, 'runs'));
      const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
      expect(ir.context.report).toBe('baked report body');
    });

    it('a single-IR artifact (compile <file> --method m -o) runs fine without --method', () => {
      const compileRes = runCli(
        ['compile', 'app/gens/echo_gen.cmb.rb', '--method', 'analyze', '-o', 'echo.ir.json'],
        ws,
      );
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'echo.ir.json');
      const runRes = runCli(['run', '--ir', artifact, '--mock'], ws);
      expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);
      expect(JSON.parse(runRes.stdout).summary).toBe('mock summary');
    });

    it('a map artifact without --method exits 2 and lists the available methods', () => {
      writeFileSync(
        join(ws, 'app/gens/multi_gen.cmb.rb'),
        `
class MultiGen < GenModel
  model "omlx:stub"
  system "inline"
  returns do
    field :summary, String
  end
  def analyze(x)
    generate "go" do
      with context: x
    end
  end
  def summarize(x)
    generate "go" do
      with context: x
    end
  end
end
`.trim(),
      );
      const compileRes = runCli(['compile', '--out-dir', 'dist/ir'], ws);
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'dist/ir/multi_gen.ir.json');

      const runRes = runCli(['run', '--ir', artifact, '--mock'], ws);
      expect(runRes.status).toBe(2);
      expect(runRes.stderr).toMatch(/--method is required/);
      expect(runRes.stderr).toMatch(/analyze/);
      expect(runRes.stderr).toMatch(/summarize/);

      // AUD-003: a --method the map does not have is the same class of
      // misuse as a mismatched --method on a single-IR artifact — exit 2.
      const bogus = runCli(['run', '--ir', artifact, '--method', 'bogus', '--mock'], ws);
      expect(bogus.status).toBe(2);
      expect(bogus.stderr).toMatch(/no method "bogus"/);
      expect(bogus.stderr).toMatch(/analyze, summarize/);
    });

    it('--profile with --ir exits 2 (profiles resolve at compile time)', () => {
      const compileRes = runCli(['compile', '--out-dir', 'dist/ir'], ws);
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'dist/ir/echo_gen.ir.json');

      const runRes = runCli(
        ['run', '--ir', artifact, '--method', 'analyze', '--profile', 'foo', '--mock'],
        ws,
      );
      expect(runRes.status).toBe(2);
      expect(runRes.stderr).toMatch(/--profile/);
    });

    it('a positional file together with --ir exits 2', () => {
      const compileRes = runCli(['compile', '--out-dir', 'dist/ir'], ws);
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(ws, 'dist/ir/echo_gen.ir.json');

      const runRes = runCli(
        ['run', 'app/gens/echo_gen.cmb.rb', '--ir', artifact, '--method', 'analyze', '--mock'],
        ws,
      );
      expect(runRes.status).toBe(2);
      expect(runRes.stderr).toMatch(/mutually exclusive/);
    });

    it('a malformed JSON artifact exits 1 with the message', () => {
      const artifact = join(ws, 'bad.ir.json');
      writeFileSync(artifact, '{not json');
      const runRes = runCli(['run', '--ir', artifact, '--mock'], ws);
      expect(runRes.status).toBe(1);
      expect(runRes.stderr).toMatch(/not valid JSON/);
    });

    it('a wrong-version artifact exits 1 with the message', () => {
      const artifact = join(ws, 'oldversion.ir.json');
      writeFileSync(
        artifact,
        JSON.stringify({ version: '0.1', entry: { class: 'EchoGen', method: 'analyze' } }),
      );
      const runRes = runCli(['run', '--ir', artifact, '--mock'], ws);
      expect(runRes.status).toBe(1);
      expect(runRes.stderr).toMatch(/unsupported compiler version/);
    });

    it('a pipeline artifact exits 1 with the DEC-001 wording', () => {
      const artifact = join(ws, 'a_pipeline.ir.json');
      writeFileSync(
        artifact,
        JSON.stringify({
          version: '0.2',
          kind: 'Pipeline',
          name: 'APipeline',
          entry: { class: 'APipeline', method: 'run', source: 'a_pipeline.pipeline.rb' },
        }),
      );
      const runRes = runCli(['run', '--ir', artifact, '--mock'], ws);
      expect(runRes.status).toBe(1);
      expect(runRes.stderr).toMatch(/needs Ruby at run time \(pipeline\)/);
    });
  });

  describe('engine-mode scratch (fixture mirrors engine_mode_e2e.test.ts)', () => {
    let scratch: string;
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'cambium-run-ir-engine-'));
    });
    afterEach(() => {
      if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    });

    function setupEngine(engineDir: string): void {
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(
        join(engineDir, 'package.json'),
        JSON.stringify({ name: 'run_ir_engine_fixture', type: 'module', private: true }) + '\n',
      );
      writeFileSync(join(engineDir, 'cambium.engine.json'), JSON.stringify({ name: 'run_ir_engine', version: '0.1.0' }));
      writeFileSync(
        join(engineDir, 'schemas.ts'),
        `
export const RunIrReport = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: true,
  $id: 'RunIrReport',
};
`.trim() + '\n',
      );
      writeFileSync(join(engineDir, 'run_ir_gen.system.md'), 'You are a test agent.\n');
      writeFileSync(
        join(engineDir, 'run_ir_corr.corrector.ts'),
        `
export const run_ir_corr = (data: any, _ctx: any) => ({
  corrected: typeof data.summary === 'string',
  output: { ...data, summary: typeof data.summary === 'string' ? data.summary.toUpperCase() : data.summary },
  issues: [],
});
`.trim() + '\n',
      );
      writeFileSync(
        join(engineDir, 'run_ir_gen.cmb.rb'),
        `
class RunIrGen < GenModel
  model "omlx:stub"
  system :run_ir_gen
  returns RunIrReport
  corrects :run_ir_corr
  def analyze(x)
    generate "x" do
      with context: x
      returns RunIrReport
    end
  end
end
`.trim() + '\n',
      );
    }

    it('a sibling artifact with entry.source tampered to a nonexistent path still discovers the engine (runs land under <engineDir>/runs, sibling corrector applies)', () => {
      const engineDir = join(scratch, 'my_engine');
      setupEngine(engineDir);
      writeFileSync(join(engineDir, 'fixture.txt'), 'hello engine world\n');

      const compileRes = spawnSync(
        'node',
        [CLI, 'compile', join(engineDir, 'run_ir_gen.cmb.rb'), '--method', 'analyze', '-o', join(engineDir, 'run_ir_gen.ir.json')],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      );
      expect(compileRes.status, compileRes.stderr).toBe(0);

      const irPath = join(engineDir, 'run_ir_gen.ir.json');
      const ir = JSON.parse(readFileSync(irPath, 'utf8'));
      // Simulate the cross-env case: entry.source recorded at compile
      // time doesn't exist on the machine running the artifact.
      ir.entry.source = '/nonexistent/host/path/run_ir_gen.cmb.rb';
      writeFileSync(irPath, JSON.stringify(ir));

      // Run from an unrelated cwd (REPO_ROOT) — engine discovery must
      // anchor on the ARTIFACT's own directory, not entry.source or cwd.
      const runRes = spawnSync(
        'node',
        [CLI, 'run', '--ir', irPath, '--method', 'analyze', '--arg', join(engineDir, 'fixture.txt'), '--mock'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CAMBIUM_ALLOW_MOCK: '1' } },
      );
      expect(runRes.status, (runRes.stderr ?? '') + (runRes.stdout ?? '')).toBe(0);

      const runsDir = join(engineDir, 'runs');
      expect(existsSync(runsDir)).toBe(true);
      const runEntries = readdirSync(runsDir).filter((e) => e.startsWith('run_'));
      expect(runEntries.length).toBeGreaterThan(0);

      const trace = JSON.parse(readFileSync(join(runsDir, runEntries[0], 'trace.json'), 'utf8'));
      const correctSteps = (trace.steps ?? []).filter((s: any) => s.type === 'Correct');
      const correctorsRan: string[] = correctSteps.flatMap((s: any) => s.meta?.correctors ?? []);
      expect(correctorsRan).toContain('run_ir_corr');
    }, 30_000);
  });

  describe('relative-source trap', () => {
    let wsA: string;
    let wsB: string;
    beforeEach(() => {
      wsA = mkdtempSync(join(tmpdir(), 'cambium-run-ir-relsrc-a-'));
      wsB = mkdtempSync(join(tmpdir(), 'cambium-run-ir-relsrc-b-'));
    });
    afterEach(() => {
      if (wsA && existsSync(wsA)) rmSync(wsA, { recursive: true, force: true });
      if (wsB && existsSync(wsB)) rmSync(wsB, { recursive: true, force: true });
    });

    function writeWorkspace(ws: string, correctorSuffix: string): void {
      mkdirSync(join(ws, 'app/gens'), { recursive: true });
      mkdirSync(join(ws, 'app/correctors'), { recursive: true });
      writeFileSync(
        join(ws, 'app/gens/tag_gen.cmb.rb'),
        `
class TagGen < GenModel
  model "omlx:stub"
  system "inline"
  corrects :tag
  returns do
    field :summary, String
  end
  def analyze(document)
    generate "go" do
      with context: document
    end
  end
end
`.trim(),
      );
      writeFileSync(
        join(ws, 'app/correctors/tag.corrector.ts'),
        `
export const tag = (data, _context) => ({
  corrected: typeof data.summary === 'string',
  output: { ...data, summary: (data.summary ?? '') + '-${correctorSuffix}' },
  issues: [],
});
`.trim(),
      );
      writeFileSync(join(ws, 'doc.txt'), 'hello\n');
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'ws', type: 'module', private: true }) + '\n');
      writeFileSync(
        join(ws, 'Genfile.toml'),
        `[package]\nname = "ws"\nversion = "0.0.0"\n\n[exports.gens]\nTagGen = "app/gens/tag_gen.cmb.rb"\n`,
      );
    }

    it("an artifact with a RELATIVE entry.source still resolves to its OWN workspace's correctors, not the run's cwd", () => {
      writeWorkspace(wsA, 'FROM-A');
      writeWorkspace(wsB, 'FROM-B');

      // Compile with a RELATIVE gen path (cwd=wsA) — `entry.source` is
      // recorded as the raw argv path, i.e. relative (ground facts).
      // `-o` doesn't create parent dirs, unlike --out-dir.
      mkdirSync(join(wsA, 'dist/ir'), { recursive: true });
      const compileRes = spawnSync(
        'node',
        [CLI, 'compile', 'app/gens/tag_gen.cmb.rb', '--method', 'analyze', '-o', 'dist/ir/tag_gen.ir.json'],
        { cwd: wsA, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      );
      expect(compileRes.status, compileRes.stderr).toBe(0);
      const artifact = join(wsA, 'dist/ir/tag_gen.ir.json');
      const ir = JSON.parse(readFileSync(artifact, 'utf8'));
      expect(ir.entry.source).toBe('app/gens/tag_gen.cmb.rb');

      // Run from wsB — an unrelated workspace that ALSO declares a `tag`
      // corrector. A naive entry.source-relative-to-cwd resolution would
      // resolve INTO wsB and pick up its (wrong) corrector.
      const runRes = spawnSync(
        'node',
        [CLI, 'run', '--ir', artifact, '--method', 'analyze', '--arg', join(wsA, 'doc.txt'), '--mock'],
        { cwd: wsB, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CAMBIUM_ALLOW_MOCK: '1' } },
      );
      expect(runRes.status, (runRes.stderr ?? '') + (runRes.stdout ?? '')).toBe(0);
      const output = JSON.parse(runRes.stdout);
      expect(output.summary.endsWith('-FROM-A')).toBe(true);
    });
  });
});
