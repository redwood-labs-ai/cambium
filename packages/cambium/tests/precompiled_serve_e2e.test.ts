/**
 * #195: `cambium serve --ir-dir` boots and serves with NO Ruby on PATH.
 *
 * Acceptance criterion 1 from the plan of record: a workspace holding a
 * precompiled artifact + a runtime `app/correctors/` plugin boots serve
 * on a machine whose PATH resolves nothing but `node`, and a request
 * round-trips through the corrector. Acceptance criterion 2: the same
 * workspace, requested the same way, returns a byte-identical response
 * (modulo `run_id`) whether serve compiled at boot or read the artifact.
 *
 * Fixture shape mirrors `genfile_no_types.test.ts`'s "shout" corrector —
 * an inline `returns do … end` schema (RED-419) needs no `[types]`
 * declaration or `contracts.ts`, so the shipped workspace is exactly
 * `Genfile.toml` + `.ir.json` + `app/correctors/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

const SHOUT_GEN = `
class ShoutGen < GenModel
  model "omlx:stub"
  system "inline"
  corrects :shout
  returns do
    field :summary, String
  end
  def analyze(document)
    generate "say something" do
      with context: document
    end
  end
end
`.trim();

const SHOUT_CORRECTOR = `
export const shout = (data, _context) => {
  const output = { ...data };
  if (typeof output.summary === 'string') output.summary = output.summary.toUpperCase();
  return { corrected: typeof data.summary === 'string', output, issues: [] };
};
`.trim();

let ws: string;
let tmpbin: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'cambium-precompiled-e2e-'));
  mkdirSync(join(ws, 'app', 'gens'), { recursive: true });
  mkdirSync(join(ws, 'app', 'correctors'), { recursive: true });
  writeFileSync(join(ws, 'app', 'gens', 'shout_gen.cmb.rb'), SHOUT_GEN);
  writeFileSync(join(ws, 'app', 'correctors', 'shout.corrector.ts'), SHOUT_CORRECTOR);
  writeFileSync(join(ws, 'doc.txt'), 'hello world\n');
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({ name: 'precompiled-e2e', type: 'module', private: true }) + '\n',
  );
  writeFileSync(
    join(ws, 'Genfile.toml'),
    `[package]
name = "precompiled-e2e"
version = "0.0.0"

[exports.gens]
ShoutGen = "app/gens/shout_gen.cmb.rb"
`,
  );

  // Compile-all with the FULL environment PATH (ruby must be reachable
  // here) — this is the build step; the serve boot below must not need it.
  const compile = spawnSync('node', [CLI, 'compile', '--out-dir', 'dist/ir'], {
    cwd: ws,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (compile.status !== 0) {
    throw new Error(`setup: cambium compile --out-dir failed:\n${compile.stderr}\n${compile.stdout}`);
  }

  // A PATH that resolves nothing but `node` — a symlink to the running
  // Node binary under a fresh, otherwise-empty directory. `ruby` (or any
  // other tool) is unreachable via PATH lookup from a spawned child.
  tmpbin = mkdtempSync(join(tmpdir(), 'cambium-tmpbin-'));
  symlinkSync(process.execPath, join(tmpbin, 'node'));
});

afterEach(() => {
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  if (tmpbin && existsSync(tmpbin)) rmSync(tmpbin, { recursive: true, force: true });
});

const LISTENING_RE = /\[cambium serve\]\s+listening on\s+tcp:\/\/([^:\s]+):(\d+)/;

/** Spawn `cambium serve` with the given extra args + env, wait for the
 *  "listening on" stderr line, then poll /v1/healthz until it answers.
 *  Returns the child process + base URL. Caller is responsible for
 *  SIGTERM + waiting for exit. */
async function bootServe(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ child: ReturnType<typeof spawn>; baseUrl: string; stderr: () => string }> {
  const child = spawn('node', [CLI, 'serve', '--workspace', ws, '--bind', 'tcp://127.0.0.1:0', ...args], {
    cwd: ws,
    env,
  });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  let stdoutBuf = '';
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });

  const port = await new Promise<string>((resolveP, rejectP) => {
    const deadline = Date.now() + 15_000;
    const exitedEarly = (code: number | null) => {
      rejectP(new Error(`cambium serve exited (code ${code}) before listening. stderr:\n${stderrBuf}\n${stdoutBuf}`));
    };
    child.once('exit', exitedEarly);
    const poll = () => {
      const m = LISTENING_RE.exec(stderrBuf);
      if (m) {
        child.off('exit', exitedEarly);
        resolveP(m[2]);
        return;
      }
      if (Date.now() > deadline) {
        rejectP(new Error(`cambium serve did not log "listening on" within 15s. stderr:\n${stderrBuf}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  // "listening on" can log a hair before the HTTP handler is fully wired.
  const healthDeadline = Date.now() + 5_000;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/v1/healthz`);
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > healthDeadline) throw new Error(`${baseUrl}/v1/healthz never came up`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return { child, baseUrl, stderr: () => stderrBuf };
}

async function stopServe(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill('SIGTERM');
  await new Promise<void>((resolveP) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveP(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolveP(); });
  });
}

describe('#195: cambium serve --ir-dir boots and serves with no Ruby on PATH', () => {
  it('POST /v1/run round-trips through the app corrector; identical to compile-at-boot modulo run_id', async () => {
    // ── Boot A: --ir-dir with a PATH that resolves ONLY `node` ──────────
    const noRubyEnv: Record<string, string | undefined> = {
      ...process.env,
      PATH: tmpbin,
      CAMBIUM_ALLOW_MOCK: '1',
    };
    const a = await bootServe(['--ir-dir', 'dist/ir'], noRubyEnv);
    try {
      expect(a.stderr()).toMatch(/precompiled: 1 gen\(s\) from/);

      const runBody = JSON.stringify({ gen: 'ShoutGen', method: 'analyze', input: 'hello world' });
      const resA = await fetch(`${a.baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: runBody,
      });
      expect(resA.status).toBe(200);
      const bodyA = await resA.json();
      expect(bodyA.ok).toBe(true);
      // The mock's "mock summary" comes back UPPERCASED — proves the
      // app corrector (app/correctors/shout.corrector.ts) was discovered
      // and ran against the precompiled dispatch's workspace anchoring.
      expect(bodyA.output.summary).toBe('MOCK SUMMARY');

      // ── Boot B: normal compile-at-boot, full PATH (ruby available) ────
      const b = await bootServe([], { ...process.env, CAMBIUM_ALLOW_MOCK: '1' });
      try {
        const resB = await fetch(`${b.baseUrl}/v1/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: runBody,
        });
        expect(resB.status).toBe(200);
        const bodyB = await resB.json();

        delete bodyA.run_id;
        delete bodyB.run_id;
        expect(bodyA).toEqual(bodyB);
      } finally {
        await stopServe(b.child);
      }
    } finally {
      await stopServe(a.child);
    }
  }, 30_000);
});
