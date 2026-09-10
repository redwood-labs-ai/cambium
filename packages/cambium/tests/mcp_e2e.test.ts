/**
 * #198: `cambium mcp` end-to-end smoke.
 *
 * Spawns the real CLI (`node cli/cambium.mjs mcp --workspace <fixture>
 * --mock`) against a hermetic tmp workspace and drives the protocol over
 * REAL stdio: initialize → notifications/initialized → tools/list
 * (asserts the expected tool + schemas) → tools/call (asserts
 * `structuredContent` equals the mock run's output). Also exercises one
 * REAL (not injected) dispatch failure end-to-end — `StrictGen`'s schema
 * is unsatisfiable by construction (`name: { not: {} }`, mirroring
 * `serve.test.ts`'s own `validation_failed` e2e recipe) — asserting
 * `structuredContent.error.kind` is the exact `/v1/run` value (DEC-008
 * round-trip). No network, no live model (`--mock`); one child process,
 * sequential calls, no concurrency (nas-pi CI is 4-core).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

const ECHO_GEN = `
class EchoGen < GenModel
  model "ollama:test"
  system "test prompt"
  returns AnalysisReport

  def analyze(doc)
    generate "analyze the document" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;

// Mirrors serve.test.ts's STRICT_FIXTURE_GEN/CONTRACTS recipe: `not: {}`
// matches nothing, so the mock-derived payload — whatever it is — can
// never validate. A real, non-injected `validation_failed`.
const STRICT_GEN = `
class StrictGen < GenModel
  model "ollama:test"
  system "test prompt"
  returns StrictReport

  def analyze(doc)
    generate "do" do
      with context: doc
      returns StrictReport
    end
  end
end
`;

const CONTRACTS = `
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  additionalProperties: true,
};

export const StrictReport = {
  $id: 'StrictReport',
  type: 'object',
  required: ['name', 'role'],
  properties: {
    name: { not: {} },
    role: { type: 'string' },
  },
  additionalProperties: false,
};
`;

let ws: string;
let childTmp: string;
afterEach(() => {
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  if (childTmp && existsSync(childTmp)) rmSync(childTmp, { recursive: true, force: true });
});

function setupWorkspace(): string {
  // Deliberately NOT prefixed `cambium-mcp-` — that's the private socket
  // dir's own naming convention (`makePrivateBind`), and a workspace
  // scaffold dir sharing it would be double-counted by anything scanning
  // the shared host tmpdir for that prefix (e.g. mcp-stdio.test.ts's
  // before/after socket-cleanup assertion, run concurrently in another
  // worker).
  const dir = mkdtempSync(join(tmpdir(), 'mcp-e2e-workspace-'));
  mkdirSync(join(dir, 'app/gens'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'app/gens/echo_gen.cmb.rb'), ECHO_GEN);
  writeFileSync(join(dir, 'app/gens/strict_gen.cmb.rb'), STRICT_GEN);
  writeFileSync(join(dir, 'src/contracts.ts'), CONTRACTS);
  // A spawned CLI process resolves `src/contracts.ts` via the tsx ESM
  // loader hook registered at cli/cambium.mjs's top; that hook needs a
  // `package.json` (`"type": "module"`) in the workspace to resolve a
  // bare `.ts` dynamic import correctly — mirrors
  // precompiled_serve_e2e.test.ts's fixture. Pre-existing `cambium serve`
  // behavior (confirmed via manual repro), not specific to `cambium mcp`.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-e2e', type: 'module', private: true }) + '\n');
  writeFileSync(
    join(dir, 'Genfile.toml'),
    `[types]
contracts = ["src/contracts.ts"]

[exports.gens]
EchoGen = "app/gens/echo_gen.cmb.rb"
StrictGen = "app/gens/strict_gen.cmb.rb"
`,
  );
  return dir;
}

const READY_RE = /\[cambium mcp\] ready \(stdio\)/;

describe('#198 cambium mcp — real CLI, real stdio, --mock', () => {
  it('initialize → tools/list → tools/call (success) → tools/call (real validation_failed)', async () => {
    ws = setupWorkspace();
    // A dedicated TMPDIR for the spawned child's own private socket dir
    // (`makePrivateBind`'s `cambium-mcp-*` mkdtemp) — otherwise it lands
    // in the shared host tmpdir for the life of this test, racing any
    // concurrently-running suite that scans that same directory for the
    // `cambium-mcp-` prefix (mcp-stdio.test.ts's socket-cleanup test).
    childTmp = mkdtempSync(join(tmpdir(), 'mcp-e2e-childtmp-'));
    const child = spawn('node', [CLI, 'mcp', '--workspace', ws, '--mock'], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: childTmp },
    });

    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    const rl = createInterface({ input: child.stdout, terminal: false });
    const lines: string[] = [];
    // AUD-198-07: a stray, unparseable stdout line — or one that parses
    // but isn't `jsonrpc: "2.0"` — is protocol corruption and must FAIL
    // the e2e, not be silently skipped by `waitForId`'s scan below.
    let protocolCorruption: string | null = null;
    rl.on('line', (l) => {
      lines.push(l);
      let parsed: any;
      try {
        parsed = JSON.parse(l);
      } catch {
        protocolCorruption ??= `stdout emitted a non-JSON line — protocol corruption: ${JSON.stringify(l)}`;
        return;
      }
      if (parsed?.jsonrpc !== '2.0') {
        protocolCorruption ??= `stdout emitted a line missing jsonrpc: "2.0" — protocol corruption: ${l}`;
      }
    });

    let nextId = 1;
    function send(method: string, params?: unknown, withId = true): number | undefined {
      const id = withId ? nextId++ : undefined;
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
      if (id !== undefined) msg.id = id;
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      return id;
    }
    async function waitForId(id: number, timeoutMs = 15_000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (protocolCorruption) throw new Error(protocolCorruption);
        for (const raw of lines) {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (parsed.id === id) return parsed;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for id=${id}. stdout lines:\n${lines.join('\n')}\nstderr:\n${stderrBuf}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    async function waitForReady(timeoutMs = 15_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!READY_RE.test(stderrBuf)) {
        if (Date.now() > deadline) throw new Error(`cambium mcp never printed "ready". stderr:\n${stderrBuf}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    try {
      await waitForReady();

      const initId = send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      const initResp = await waitForId(initId!);
      expect(initResp.result.protocolVersion).toBe('2025-06-18');
      expect(initResp.result.serverInfo.name).toBe('cambium');

      send('notifications/initialized', {}, false);

      const listId = send('tools/list', {});
      const listResp = await waitForId(listId!);
      const tools = listResp.result.tools as any[];
      const echoTool = tools.find((t) => t.name === 'EchoGen__analyze');
      const strictTool = tools.find((t) => t.name === 'StrictGen__analyze');
      expect(echoTool).toBeDefined();
      expect(strictTool).toBeDefined();
      expect(echoTool.inputSchema).toEqual({
        type: 'object',
        properties: { input: { type: 'string', description: "Content for the gen's document context" } },
        required: ['input'],
      });
      expect(echoTool.outputSchema).toMatchObject({ $id: 'AnalysisReport' });

      const okId = send('tools/call', { name: 'EchoGen__analyze', arguments: { input: 'System is down; checkout failing.' } });
      const okResp = await waitForId(okId!);
      expect(okResp.error).toBeUndefined();
      expect(okResp.result.isError).toBeUndefined();
      expect(okResp.result.structuredContent).toBeDefined();
      expect(JSON.parse(okResp.result.content[0].text)).toEqual(okResp.result.structuredContent);

      const failId = send('tools/call', { name: 'StrictGen__analyze', arguments: { input: 'anything' } });
      const failResp = await waitForId(failId!);
      expect(failResp.error).toBeUndefined(); // dispatch failure is a RESULT, not a JSON-RPC error (DEC-008)
      expect(failResp.result.isError).toBe(true);
      expect(failResp.result.structuredContent.error.kind).toBe('validation_failed');
      expect(JSON.parse(failResp.result.content[0].text).error).toEqual(failResp.result.structuredContent.error);

      // Clean shutdown: stdin EOF → exit 0, no lingering process.
      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolveP) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveP(-1); }, 10_000);
        child.once('exit', (code) => { clearTimeout(timer); resolveP(code); });
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});

// ── AUD-198-02: boot-failure variants must not leak the private socket
// tmpdir. The fix lives in cli/mcp.mjs's boot catch (`await
// handle.close().catch(() => {})` before `process.exit(1)`) — these
// tests spawn the REAL CLI (like the suite above) because the
// regression is specifically in that catch block, not in
// `runMcpStdio`'s own (already-correct) `close()`. Each test gives the
// child its own dedicated `TMPDIR` so "is it empty afterward" is a
// direct assertion rather than a before/after diff. ──────────────────

const COLLIDE_A__B_GEN = `
class A__b < GenModel
  model "ollama:test"
  system "test prompt"
  returns AnalysisReport

  def c(doc)
    generate "analyze the document" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;

// Method `b__c` on gen `A` collides with `A__b`'s method `c` under the
// `<GenName>__<method>` naming scheme — both produce tool name
// `A__b__c`. This is the realistic cross-gen shape (SECURITY-AUDIT-198
// § AUD-198-05); two entries can never share a `name` in a real catalog,
// which is why the fixture uses two DIFFERENT gen names rather than one
// name repeated.
const COLLIDE_A_GEN = `
class A < GenModel
  model "ollama:test"
  system "test prompt"
  returns AnalysisReport

  def b__c(doc)
    generate "analyze the document" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;

// CI incident (Forgejo run 363, head 9ded6c8): a bare `expect(-1).toBe(1)`
// gives the next reader nothing to diagnose from. `exitCode: -1` is this
// helper's OWN sentinel for "the test's timeout fired and we SIGKILLed
// the child" — never a real signal the child received — so `signal`
// distinguishes that from an actual `exit` event's signal, and both ship
// alongside `stderr` so a future failure's assertion message carries the
// child's own diagnostics instead of a bare number mismatch.
async function spawnMcpAndWaitForExit(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<{ exitCode: number | null; stderr: string; signal: string | null }> {
  return new Promise((resolveP) => {
    const child = spawn('node', [CLI, 'mcp', ...args], { cwd: REPO_ROOT, env });
    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    child.stdout.resume(); // drain and ignore — these runs never reach "ready"
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveP({ exitCode: -1, stderr: stderrBuf, signal: 'SIGKILL (test timeout — child never exited)' });
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, stderr: stderrBuf, signal });
    });
  });
}

// #198 CI incident (Forgejo run 363, head 9ded6c8): whether an overlong
// AF_UNIX `sun_path` actually fails `listen()` is NOT constant across
// Node versions. `PipeWrap::Bind` (src/pipe_wrap.cc) calls
// `uv_pipe_bind2(handle, name, len, flags)`; Node <23 passes `flags: 0`,
// Node >=23 passes `UV_PIPE_NO_TRUNCATE` (confirmed by diffing
// nodejs/node v22.23.2 against v23.11.1+ directly). libuv's documented
// behavior for `flags: 0` is to SILENTLY TRUNCATE a `sun_path` over 108
// bytes and bind at the truncated location instead of returning
// `UV_EINVAL` — reproduced locally: the SAME overlong-TMPDIR construction
// that reliably throws `EINVAL` on Node 26 (this repo's dev toolchain)
// binds successfully, at a truncated path, on Node 22.23.2 — which is
// exactly what `.forgejo/workflows/unit-tests.yml` runs `npm test` under.
// No amount of TMPDIR padding fixes this: the truncation is unconditional
// past 108 bytes on Node <23, however far past. This is a genuine runtime
// probe, not a hardcoded version check, so a Node <23 patch backport (or
// any other libuv/Node change either direction) self-corrects the gate
// without anyone having to revisit this file.
/** `mcp-stdio` builds its private socket under TMPDIR, and a unix socket path
 *  must fit in `sockaddr_un.sun_path` (104 bytes on macOS, 108 on Linux). A
 *  private TMPDIR that is itself a `mkdtemp` dir under the real TMPDIR clears
 *  that on Linux but overflows it on macOS, where `tmpdir()` is already ~49
 *  chars — so tests that want to reach some *other* boot failure must anchor
 *  their TMPDIR on a short base, or they get the socket-length refusal first
 *  and assert against the wrong error. */
const SHORT_TMP_BASE = process.platform === 'win32' ? tmpdir() : '/tmp';

describe('#198 cambium mcp — boot-failure cleanup (AUD-198-02)', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const d = cleanupDirs.pop()!;
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  it('bad workspace (no Genfile.toml): boot fails, exit 1, private socket tmpdir cleaned up', async () => {
    const badWs = mkdtempSync(join(tmpdir(), 'mcp-e2e-bootfail-badws-'));
    const privateTmp = mkdtempSync(join(SHORT_TMP_BASE, 'mcp-e2e-bootfail-privtmp-'));
    cleanupDirs.push(badWs, privateTmp);

    const { exitCode, stderr, signal } = await spawnMcpAndWaitForExit(
      ['--workspace', badWs],
      { ...process.env, TMPDIR: privateTmp },
    );
    expect(exitCode, `signal=${signal}\nstderr:\n${stderr}`).toBe(1);
    expect(stderr).toMatch(/boot failed/);
    expect(readdirSync(privateTmp).filter((n) => n.startsWith('cambium-mcp-'))).toHaveLength(0);
  }, 20_000);

  it('tool-name collision (real A__b / A pair): boot fails, exit 1, private socket tmpdir cleaned up', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'mcp-e2e-bootfail-collide-'));
    const privateTmp = mkdtempSync(join(SHORT_TMP_BASE, 'mcp-e2e-bootfail-privtmp-'));
    cleanupDirs.push(ws, privateTmp);
    mkdirSync(join(ws, 'app/gens'), { recursive: true });
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'app/gens/a__b.cmb.rb'), COLLIDE_A__B_GEN);
    writeFileSync(join(ws, 'app/gens/a.cmb.rb'), COLLIDE_A_GEN);
    writeFileSync(join(ws, 'src/contracts.ts'), CONTRACTS);
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'mcp-collide', type: 'module', private: true }) + '\n');
    writeFileSync(
      join(ws, 'Genfile.toml'),
      `[types]
contracts = ["src/contracts.ts"]

[exports.gens]
A__b = "app/gens/a__b.cmb.rb"
A = "app/gens/a.cmb.rb"
`,
    );

    const { exitCode, stderr, signal } = await spawnMcpAndWaitForExit(
      ['--workspace', ws],
      { ...process.env, TMPDIR: privateTmp },
    );
    expect(exitCode, `signal=${signal}\nstderr:\n${stderr}`).toBe(1);
    expect(stderr).toMatch(/tool name collision/);
    expect(readdirSync(privateTmp).filter((n) => n.startsWith('cambium-mcp-'))).toHaveLength(0);
  }, 20_000);

  // No longer version-gated. The bind used to decide this outcome, and it
  // decided differently per Node: >=23 failed with a bare `EINVAL`, <23
  // silently truncated `sun_path` and "succeeded" at a path the HTTP client
  // was never given. `makePrivateBind` now measures the path itself, so the
  // refusal is deterministic everywhere and this runs on CI (Node 22) too.
  it(
    'socket path overflow (long TMPDIR): boot fails with the length, exit 1, private socket tmpdir cleaned up',
    async () => {
      const ws = setupWorkspace();
      const longBase = mkdtempSync(join(SHORT_TMP_BASE, 'mcp-e2e-bootfail-longbase-'));
      const longDir = join(longBase, 'x'.repeat(150));
      mkdirSync(longDir, { recursive: true });
      cleanupDirs.push(ws, longBase);

      const { exitCode, stderr, signal } = await spawnMcpAndWaitForExit(
        ['--workspace', ws],
        { ...process.env, TMPDIR: longDir },
      );
      expect(exitCode, `signal=${signal}\nstderr:\n${stderr}`).toBe(1);
      expect(stderr).toMatch(/boot failed/);
      // The diagnosis, not just the failure: the byte count, the limit, and
      // the fact that TMPDIR is the knob. `EINVAL` alone named none of these.
      expect(stderr).toMatch(/over this platform's \d+-byte limit for a unix socket/);
      expect(stderr).toMatch(/TMPDIR/);
      // The regression AUD-198-02 found: the mkdtemp'd socket dir inside
      // `longDir` (created before the bind attempt) was left behind
      // because the CLI's boot catch never called handle.close().
      expect(readdirSync(longDir).filter((n) => n.startsWith('cambium-mcp-'))).toHaveLength(0);
    },
    20_000,
  );
});
