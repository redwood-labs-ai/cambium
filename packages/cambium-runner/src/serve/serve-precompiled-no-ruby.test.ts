/**
 * #242 fix round, AUD-001: `cambium serve --precompiled` (or `--ir-dir`)
 * must boot with NO Ruby reachable anywhere — that's the whole point of
 * #195's precompiled artifact path (see `serve.ts`'s top-of-file
 * docstring and CLAUDE.md's "Precompiled artifacts are closed IRs"
 * section). #242 introduced a single shared `resolveCompileRb` and had
 * `runServe` call it — and throw synchronously on total resolution
 * failure — unconditionally at the top of the function, before
 * `precompiledMode` is even computed. That regresses this exact
 * contract: a workspace with no `ruby/cambium/compile.rb` reachable via
 * any link (no explicit `compileRb`, no `CAMBIUM_COMPILE_RB`, no
 * `@redwood-labs/cambium` sibling) now fails to boot even in
 * `--precompiled` mode, where nothing downstream ever dereferences the
 * resolved path (the boot loop reads `.ir.json` artifacts directly, and
 * `gen-catalog.ts` refuses `[exports.pipelines]` — the only per-request
 * consumer of `compileRb` — outright in precompiled mode).
 *
 * This is a dedicated file (not added to `serve.test.ts`) because it
 * needs `resolveCompileRb` itself to fail, which the real function
 * can't be made to do from inside this repo checkout (the in-tree dev
 * fallback always resolves here) — same reasoning as
 * `memory-exit-listener.test.ts`'s dedicated module mock for a
 * dependency that can't be forced to its edge case any other way.
 * Mocking `../compile-rb.js` for the whole file would break every other
 * `serve.test.ts` test that needs a REAL compile.rb to spawn.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stand in for "no ruby/cambium/compile.rb reachable via any link" —
// the exact condition #195's docstring says should still boot clean in
// precompiled mode. Only this file's copy of the module is affected.
vi.mock('../compile-rb.js', () => ({
  resolveCompileRb: () => null,
}));

import { parseBind } from './bind.js';
import { runServe, type RunServeHandle } from './serve.js';

const REPO_ROOT = process.cwd();
const RUBY_COMPILE_RB = join(REPO_ROOT, 'ruby', 'cambium', 'compile.rb');

const FIXTURE_GEN = `
class TestGen < GenModel
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

const FIXTURE_CONTRACTS = `
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  additionalProperties: true,
};
`;

describe('runServe — precompiled boot with no Ruby reachable (#242 AUD-001)', () => {
  let tmp: string;
  let handle: RunServeHandle | undefined;
  let prevMock: string | undefined;
  let prevCompileRbEnv: string | undefined;

  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    handle = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (prevCompileRbEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
    else process.env.CAMBIUM_COMPILE_RB = prevCompileRbEnv;
  });

  it('boots and serves with no explicit compileRb, no CAMBIUM_COMPILE_RB, and resolution guaranteed to fail', async () => {
    prevCompileRbEnv = process.env.CAMBIUM_COMPILE_RB;
    delete process.env.CAMBIUM_COMPILE_RB;

    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-precompiled-no-ruby-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
    writeFileSync(join(tmp, 'src/contracts.ts'), FIXTURE_CONTRACTS);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[package]
name = "serve-precompiled-no-ruby"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"
`,
    );

    // Produce the precompiled artifact the way `cambium compile --write`
    // would, offline, before boot — this is test setup, not part of the
    // boot path under test. The real `runServe` call below never spawns
    // ruby: it reads this artifact file directly (#195), and the mocked
    // `resolveCompileRb` above proves it never even tries to resolve one.
    const compiled = spawnSync('ruby', [RUBY_COMPILE_RB, join(tmp, 'app/gens/test_gen.cmb.rb')], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (compiled.status !== 0) {
      throw new Error(`ruby compile.rb fixture setup failed (exit ${compiled.status}):\n${compiled.stderr}`);
    }
    writeFileSync(join(tmp, 'app/gens/test_gen.ir.json'), compiled.stdout);

    // The regression: this used to throw synchronously, right here,
    // before precompiled boot logic ever ran.
    expect(() => {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        precompiled: true,
      });
    }).not.toThrow();

    const addr = await handle!.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const health = await fetch(`${baseUrl}/v1/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json()).gens).toEqual(['TestGen']);

    const run = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'a document with 42 ms in it' }),
    });
    expect(run.status).toBe(200);
    const runBody = await run.json();
    expect(runBody.ok).toBe(true);
    expect(runBody.output).toMatchObject({ summary: expect.any(String) });
  });
});
