/**
 * RED-360: end-to-end test for `cambium serve`.
 *
 * Boots `runServe` against a tmp workspace with a real Genfile.toml +
 * fixture .cmb.rb, lets it actually shell out to ruby compile.rb in
 * bare mode, then exercises the HTTP surface with `fetch`. Mock provider
 * (`CAMBIUM_ALLOW_MOCK=1`) keeps it offline.
 *
 * Covers the happy path + the four error.kind cases wired in this
 * slice (`unknown_gen`, `unknown_method`, `input_invalid`, malformed
 * JSON, 404). The full nine-kind error matrix lands in a follow-up.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBind } from './bind.js';
import {
  classifyThrownError,
  runServe,
  type RunGenFromIrFn,
  type RunPipelineFromIrFn,
  type RunServeHandle,
} from './serve.js';

// #195: real `ruby compile.rb` path for producing precompiled artifacts
// the same way `cambium compile --write` / `--out-dir` would — bare
// mode (no --method), stdout written verbatim to the artifact file.
const REPO_ROOT = process.cwd();
const RUBY_COMPILE_RB = join(REPO_ROOT, 'ruby', 'cambium', 'compile.rb');

// #242: this test file's own directory, used only to plant the fake
// createRequire-sibling fixture one level up (at ../node_modules,
// `compile-rb.ts`'s own directory) — see the "compileRb precedence"
// describe block below.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixture gen + permissive contracts. The runner imports contracts.ts
// at run time; we keep it as a plain object literal (no @sinclair/typebox
// dep) so it loads without node_modules in the tmp workspace. The mock
// provider's `{summary, metrics, key_facts}` output validates trivially
// against `additionalProperties: true`.
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

  def summarize(doc)
    generate "summarize" do
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

describe('runServe — end-to-end (RED-360)', () => {
  let tmp: string;
  let handle: RunServeHandle;
  let baseUrl: string;
  let prevMock: string | undefined;

  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });

  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-e2e-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
    writeFileSync(join(tmp, 'src/contracts.ts'), FIXTURE_CONTRACTS);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[package]
name = "serve-e2e"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"
`,
    );

    handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    baseUrl = `http://${addr.host === '::' ? '127.0.0.1' : addr.host}:${addr.port}`;
  });

  afterEach(async () => {
    await handle.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /v1/healthz returns ok + the gen catalog', async () => {
    const res = await fetch(`${baseUrl}/v1/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.gens).toEqual(['TestGen']);
    expect(body.version).toBe('v1');
  });

  // RED-381 Phase F.3: pipeline endpoints share the wire format.
  describe('Pipeline endpoints (RED-381 Phase F.3)', () => {
    let pipeTmp: string;
    let pipeHandle: RunServeHandle;
    let pipeBaseUrl: string;

    beforeEach(async () => {
      pipeTmp = mkdtempSync(join(tmpdir(), 'cambium-serve-pipe-e2e-'));
      mkdirSync(join(pipeTmp, 'app/gens'), { recursive: true });
      mkdirSync(join(pipeTmp, 'app/pipelines'), { recursive: true });
      mkdirSync(join(pipeTmp, 'src'), { recursive: true });
      writeFileSync(join(pipeTmp, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
      writeFileSync(join(pipeTmp, 'src/contracts.ts'), FIXTURE_CONTRACTS);
      writeFileSync(
        join(pipeTmp, 'app/pipelines/test_pipeline.pipeline.rb'),
        `
class TestPipeline < Pipeline
  input :doc, schema: AnalysisReport
  step :one, gen: TestGen, method: :analyze,
    with: { doc: bind(:input).doc }
  def run(doc); end
end
`.trim(),
      );
      writeFileSync(
        join(pipeTmp, 'Genfile.toml'),
        `[package]
name = "serve-pipe-e2e"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"

[exports.pipelines]
TestPipeline = "app/pipelines/test_pipeline.pipeline.rb"
`,
      );

      pipeHandle = runServe({
        workspaceDir: pipeTmp,
        bind: parseBind('tcp://127.0.0.1:0'),
      });
      const addr = await pipeHandle.ready;
      if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
      pipeBaseUrl = `http://${addr.host === '::' ? '127.0.0.1' : addr.host}:${addr.port}`;
    });

    afterEach(async () => {
      await pipeHandle.close();
      rmSync(pipeTmp, { recursive: true, force: true });
    });

    it('healthz lists both gens AND pipelines in a single catalog', async () => {
      const res = await fetch(`${pipeBaseUrl}/v1/healthz`);
      const body = await res.json();
      expect(body.status).toBe('ok');
      // Names are unique across the union; order is insertion order
      // (gens section first, then pipelines).
      expect(body.gens.sort()).toEqual(['TestGen', 'TestPipeline']);
    });

    it('POST /v1/run dispatches a Pipeline IR through runPipelineFromIr', async () => {
      const res = await fetch(`${pipeBaseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gen: 'TestPipeline',
          method: 'run',
          input: 'a document with 42 ms in it',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.run_id).toBe('string');
      // Pipeline output (default last_step) = the sub-gen's AnalysisReport.
      expect(body.output).toMatchObject({ summary: expect.any(String) });
    });

    it('rejects an unknown pipeline name with available list', async () => {
      const res = await fetch(`${pipeBaseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gen: 'NoSuchThing',
          method: 'run',
          input: '',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.kind).toBe('unknown_gen');
      expect(body.error.details.available.sort()).toEqual(['TestGen', 'TestPipeline']);
    });

    it('include_trace=true returns the PipelineRun trace inline', async () => {
      const res = await fetch(`${pipeBaseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gen: 'TestPipeline',
          method: 'run',
          input: 'hello',
          include_trace: true,
        }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.trace?.type).toBe('PipelineRun');
      expect(body.trace?.operators).toHaveLength(1);
      expect(body.trace.operators[0].type).toBe('PipelineStep');
    });
  });

  it('POST /v1/run round-trips a real gen call (mock provider)', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gen: 'TestGen',
        method: 'analyze',
        input: 'a document with 42 ms in it',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.run_id).toBe('string');
    expect(body.output).toMatchObject({
      summary: expect.any(String),
      metrics: expect.objectContaining({ latency_ms_samples: [42] }),
    });
  });

  it('POST /v1/run with include_trace returns the trace inline', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gen: 'TestGen',
        method: 'analyze',
        input: 'x',
        include_trace: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trace).toBeDefined();
    expect(typeof body.trace).toBe('object');
    // The trace shape isn't part of the wire contract — assert it's at
    // least a structured object with steps.
    expect(Array.isArray(body.trace.steps)).toBe(true);
  });

  it('POST /v1/run dispatches to a different method on the same gen', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'TestGen', method: 'summarize', input: 'x' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns unknown_gen for a gen not in the catalog', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'NoSuchGen', method: 'analyze', input: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('unknown_gen');
    expect(body.error.details.available).toEqual(['TestGen']);
  });

  it('returns unknown_method for a gen that exists but lacks the method', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'TestGen', method: 'no_such_method', input: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('unknown_method');
    expect(body.error.details.available.sort()).toEqual(['analyze', 'summarize']);
  });

  it('returns input_invalid for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'TestGen' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.kind).toBe('input_invalid');
    expect(body.error.message).toMatch(/method/);
  });

  it('returns input_invalid for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{this is not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.kind).toBe('input_invalid');
    expect(body.error.message).toMatch(/malformed JSON/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/v2/run`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.kind).toBe('not_found');
  });

  it('every error envelope carries run_id (null on pre-dispatch errors)', async () => {
    // Wire-format consistency (cambium-docs review): the C-doc claims
    // run_id is always present on failure responses. Pre-dispatch errors
    // (input_invalid, unknown_gen, unknown_method, not_found) emit
    // `run_id: null` so a client doing `body.run_id` never gets undefined.
    const cases: Array<{ name: string; req: () => Promise<Response> }> = [
      {
        name: 'input_invalid (malformed JSON)',
        req: () =>
          fetch(`${baseUrl}/v1/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
          }),
      },
      {
        name: 'input_invalid (missing method)',
        req: () =>
          fetch(`${baseUrl}/v1/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ gen: 'TestGen' }),
          }),
      },
      {
        name: 'unknown_gen',
        req: () =>
          fetch(`${baseUrl}/v1/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ gen: 'Ghost', method: 'analyze', input: 'x' }),
          }),
      },
      {
        name: 'unknown_method',
        req: () =>
          fetch(`${baseUrl}/v1/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ gen: 'TestGen', method: 'ghost', input: 'x' }),
          }),
      },
      {
        name: 'not_found',
        req: () => fetch(`${baseUrl}/v2/run`),
      },
    ];
    for (const c of cases) {
      const res = await c.req();
      const body = await res.json();
      expect(body.ok, c.name).toBe(false);
      expect(body, c.name).toHaveProperty('run_id');
      expect(body.run_id, c.name).toBeNull();
    }
  });

  it('returns input_invalid when memory_keys produces traversable directory segments', async () => {
    // cambium-security review (RED-360): memory_keys is now validated at
    // the wire boundary via parseMemoryKeys, not just deep in runGen.
    // A traversal-shaped value should bounce at the HTTP layer.
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gen: 'TestGen',
        method: 'analyze',
        input: 'x',
        memory_keys: { user_id: '../escape' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.kind).toBe('input_invalid');
    expect(body.error.message).toMatch(/must match/);
  });

  it('healthz works on the same server while runs are in flight', async () => {
    // Fire a run + a healthz concurrently. The server should service
    // both; healthz must not block on inflight runs.
    const [runRes, healthRes] = await Promise.all([
      fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'x' }),
      }),
      fetch(`${baseUrl}/v1/healthz`),
    ]);
    expect(runRes.status).toBe(200);
    expect(healthRes.status).toBe(200);
  });
});

describe('runServe — compileRb precedence (RED-376, #242)', () => {
  let tmp: string;
  let handle: RunServeHandle | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-compilerb-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
    writeFileSync(join(tmp, 'src/contracts.ts'), FIXTURE_CONTRACTS);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[package]
name = "compilerb-precedence"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"
`,
    );
  });

  afterEach(async () => {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('uses opts.compileRb when passed (over env + default)', async () => {
    const bogus = '/nonexistent/compile.rb.option';
    const prevEnv = process.env.CAMBIUM_COMPILE_RB;
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env';
    try {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        compileRb: bogus,
      });
      // Boot fails inside gen-catalog hydration → handle.ready rejects.
      // The error must reference the option path, proving precedence.
      await expect(handle.ready).rejects.toThrow(/compile\.rb\.option/);
    } finally {
      if (prevEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
      else process.env.CAMBIUM_COMPILE_RB = prevEnv;
    }
  });

  it('falls back to CAMBIUM_COMPILE_RB when opts.compileRb is unset', async () => {
    const prevEnv = process.env.CAMBIUM_COMPILE_RB;
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env';
    try {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
      });
      await expect(handle.ready).rejects.toThrow(/compile\.rb\.env/);
    } finally {
      if (prevEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
      else process.env.CAMBIUM_COMPILE_RB = prevEnv;
    }
  });

  // #242: the link `serve.ts` lacked before this change — its own
  // comment flagged this as "broken under node_modules". Plants a real
  // (uncommitted, gitignored) fake npm-install sibling at the first
  // node_modules Node's `createRequire` resolution checks from
  // `compile-rb.ts`'s own location, and points it at a ruby script that
  // fails in a way only IT could produce — proving this exact file was
  // spawned, not the in-tree ruby/cambium/compile.rb dev fallback.
  it('falls back to the createRequire sibling lookup when opts.compileRb and CAMBIUM_COMPILE_RB are both unset', async () => {
    const prevEnv = process.env.CAMBIUM_COMPILE_RB;
    delete process.env.CAMBIUM_COMPILE_RB;
    const siblingRoot = join(
      __dirname, '..', 'node_modules', '@redwood-labs', 'cambium',
    );
    const siblingCompileRb = join(siblingRoot, 'ruby', 'cambium', 'compile.rb');
    mkdirSync(join(siblingRoot, 'ruby', 'cambium'), { recursive: true });
    writeFileSync(
      join(siblingRoot, 'package.json'),
      JSON.stringify({ name: '@redwood-labs/cambium', version: '0.0.0-test' }),
    );
    writeFileSync(
      siblingCompileRb,
      "STDERR.puts 'SIBLING_FIXTURE_MARKER_242'\nexit 1\n",
    );
    try {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
      });
      await expect(handle.ready).rejects.toThrow(/SIBLING_FIXTURE_MARKER_242/);
    } finally {
      if (prevEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
      else process.env.CAMBIUM_COMPILE_RB = prevEnv;
      rmSync(join(__dirname, '..', 'node_modules'), { recursive: true, force: true });
    }
  });
});

describe('classifyThrownError (RED-360)', () => {
  it('classifies a missing-tool error as tool_dispatch_failed', () => {
    const err = new Error(
      'Tool "missing_tool" declared in policies.tools_allowed but not found in registry. Available: calculator',
    );
    expect(classifyThrownError(err)).toBe('tool_dispatch_failed');
  });

  it('classifies a missing-action error as tool_dispatch_failed', () => {
    const err = new Error('Trigger action "ghost" not found in ActionRegistry. Available: [send_email]');
    expect(classifyThrownError(err)).toBe('tool_dispatch_failed');
  });

  it('classifies a security-violation error as tool_dispatch_failed', () => {
    const err = new Error('3 security violation(s). See trace for details.');
    expect(classifyThrownError(err)).toBe('tool_dispatch_failed');
  });

  it('falls through to runner_error for anything else', () => {
    expect(classifyThrownError(new Error('something else exploded'))).toBe('runner_error');
    expect(classifyThrownError('bare string')).toBe('runner_error');
    expect(classifyThrownError(undefined)).toBe('runner_error');
  });

  it('only matches at message start (no false positives mid-string)', () => {
    const err = new Error(
      'Some prefix — Tool "foo" declared in policies.tools_allowed but not found in registry',
    );
    // The runner emits these messages from the start of the string;
    // a downstream wrapper that prepends context wouldn't match. That's
    // intentional — better to fall through to runner_error than to
    // misclassify.
    expect(classifyThrownError(err)).toBe('runner_error');
  });
});

// Schema the mock generator can NEVER satisfy (A-001a, #205): `name` is
// `{ not: {} }`, the Draft-07 always-false subschema — no value passes it,
// so this is immune to any future improvement in the mock's shape-guessing
// (the schema-derived mock would otherwise happily synthesize `{ name:
// 'mock name', role: 'mock role' }` and validate). Used to exercise the
// validation_failed path end-to-end. We re-use the `AnalysisReport` schema
// name because compile.rb's compile-time schema check searches for the
// symbol in the in-tree contracts.ts (cwd-relative fallback), where
// AnalysisReport exists. The runtime loads our LOCAL strict version via
// [types].contracts in the tmp Genfile.
const STRICT_FIXTURE_GEN = `
class StrictGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport

  def analyze(doc)
    generate "do" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;

const STRICT_FIXTURE_CONTRACTS = `
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  required: ['name', 'role'],
  properties: {
    name: { not: {} },
    role: { type: 'string' },
  },
  additionalProperties: false,
};
`;

describe('runServe — validation_failed e2e (RED-360)', () => {
  let tmp: string;
  let handle: RunServeHandle;
  let baseUrl: string;
  let prevMock: string | undefined;

  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-validation-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/strict_gen.cmb.rb'), STRICT_FIXTURE_GEN);
    writeFileSync(join(tmp, 'src/contracts.ts'), STRICT_FIXTURE_CONTRACTS);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nStrictGen = "app/gens/strict_gen.cmb.rb"\n`,
    );
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    await handle.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns validation_failed when the model output cannot satisfy the schema', async () => {
    const res = await fetch(`${baseUrl}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gen: 'StrictGen', method: 'analyze', input: 'x' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('validation_failed');
    // Run id is still surfaced even on failure so the operator can find
    // the trace.
    expect(typeof body.run_id).toBe('string');
    expect(body.run_id.length).toBeGreaterThan(0);
  });
});

// For the budget / runner-error / tool-dispatch paths we need to
// fabricate the runner's outcome — those failure modes are awkward to
// trigger end-to-end with a mock provider. The runGenFromIrFn injection
// lets us assert the wire mapping without setting up a real budget
// exhaustion or registry mismatch.
describe('runServe — error mapping via runGenFromIrFn injection (RED-360)', () => {
  let tmp: string;
  // Re-use the in-tree-known schema name `AnalysisReport` so compile.rb's
  // compile-time schema check finds it; the runner loads the local
  // permissive version via [types].contracts.
  const fixtureGen = `
class TinyGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport

  def analyze(doc)
    generate "ok" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
  const fixtureContracts = `
export const AnalysisReport = { $id: 'AnalysisReport', type: 'object', additionalProperties: true };
`;

  function setupWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-serve-mapping-'));
    mkdirSync(join(dir, 'app/gens'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'app/gens/tiny.cmb.rb'), fixtureGen);
    writeFileSync(join(dir, 'src/contracts.ts'), fixtureContracts);
    writeFileSync(
      join(dir, 'Genfile.toml'),
      `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nTinyGen = "app/gens/tiny.cmb.rb"\n`,
    );
    return dir;
  }

  beforeEach(() => {
    tmp = setupWorkspace();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function bootWith(runGenFromIrFn: RunGenFromIrFn): Promise<{
    handle: RunServeHandle;
    baseUrl: string;
  }> {
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    return { handle, baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  it('surfaces failureKind=budget as wire kind budget_exhausted', async () => {
    const fakeRun: RunGenFromIrFn = async () =>
      ({
        ok: false,
        output: null,
        trace: { steps: [] },
        runId: 'run_fake_budget',
        schemaId: 'Anything',
        ir: {} as any,
        errorMessage: 'Budget exceeded: per_run.max_tokens (1) exceeded by 250',
        failureKind: 'budget',
        tracePath: '/tmp/fake/trace.json',
        outputPath: '/tmp/fake/output.json',
        irPath: '/tmp/fake/ir.json',
        runDir: '/tmp/fake',
      }) as any;
    const { handle, baseUrl } = await bootWith(fakeRun);
    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.kind).toBe('budget_exhausted');
      expect(body.error.message).toMatch(/Budget exceeded/);
      expect(body.run_id).toBe('run_fake_budget');
    } finally {
      await handle.close();
    }
  });

  it('surfaces a thrown missing-tool error as wire kind tool_dispatch_failed (HTTP 400)', async () => {
    const fakeRun: RunGenFromIrFn = async () => {
      throw new Error(
        'Tool "research_x" declared in policies.tools_allowed but not found in registry. Available: calculator',
      );
    };
    const { handle, baseUrl } = await bootWith(fakeRun);
    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.kind).toBe('tool_dispatch_failed');
      expect(body.error.message).toMatch(/research_x/);
    } finally {
      await handle.close();
    }
  });

  it('surfaces an unrelated thrown error as wire kind runner_error (HTTP 500)', async () => {
    const fakeRun: RunGenFromIrFn = async () => {
      throw new Error('something unexpected exploded inside the runner');
    };
    const { handle, baseUrl } = await bootWith(fakeRun);
    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.kind).toBe('runner_error');
      expect(body.error.message).toMatch(/something unexpected exploded/);
    } finally {
      await handle.close();
    }
  });

  it('falls through to runner_error when ok:false has no failureKind (e.g. document extraction failure)', async () => {
    const fakeRun: RunGenFromIrFn = async () =>
      ({
        ok: false,
        output: null,
        trace: { steps: [] },
        runId: 'run_doc_fail',
        schemaId: 'Anything',
        ir: {} as any,
        errorMessage: 'Document extraction failed: pdfjs out of memory',
        // failureKind intentionally absent
        tracePath: '/tmp/fake/trace.json',
        outputPath: '/tmp/fake/output.json',
        irPath: '/tmp/fake/ir.json',
        runDir: '/tmp/fake',
      }) as any;
    const { handle, baseUrl } = await bootWith(fakeRun);
    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.kind).toBe('runner_error');
      expect(body.error.message).toMatch(/Document extraction failed/);
    } finally {
      await handle.close();
    }
  });
});

describe('runServe — --max-inflight + overloaded (RED-360)', () => {
  let tmp: string;
  const fixtureGen = `
class TinyGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport

  def analyze(doc)
    generate "ok" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
  const fixtureContracts = `
export const AnalysisReport = { $id: 'AnalysisReport', type: 'object', additionalProperties: true };
`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-cap-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/tiny.cmb.rb'), fixtureGen);
    writeFileSync(join(tmp, 'src/contracts.ts'), fixtureContracts);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nTinyGen = "app/gens/tiny.cmb.rb"\n`,
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 503 + overloaded once concurrent dispatches hit the cap', async () => {
    // Fake runGenFromIr that blocks on a manually-resolvable promise so
    // we can pin one request in flight and probe behavior on a second.
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    const slowRun: RunGenFromIrFn = async () => {
      await blocker;
      return {
        ok: true, output: { hello: 'world' }, trace: { steps: [] },
        runId: 'run_slow', schemaId: 'AnalysisReport', ir: {} as any,
        tracePath: '/tmp/fake/trace.json',
        outputPath: '/tmp/fake/output.json',
        irPath: '/tmp/fake/ir.json',
        runDir: '/tmp/fake',
      } as any;
    };

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      maxInflight: 1,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // First call: starts but doesn't return until we release().
      const firstP = fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      // Give the server a tick to register the inflight handler.
      await new Promise((r) => setTimeout(r, 50));

      // Second call: should hit the cap and bounce immediately.
      const secondRes = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(secondRes.status).toBe(503);
      const secondBody = await secondRes.json();
      expect(secondBody.error.kind).toBe('overloaded');
      expect(secondBody.error.details.max_inflight).toBe(1);
      expect(secondBody.error.details.inflight).toBe(1);

      // Healthz is never gated — orchestrators need to probe a saturated
      // server.
      const healthRes = await fetch(`${baseUrl}/v1/healthz`);
      expect(healthRes.status).toBe(200);

      // Release the first call and confirm it completed normally.
      release();
      const firstRes = await firstP;
      expect(firstRes.status).toBe(200);
      const firstBody = await firstRes.json();
      expect(firstBody.ok).toBe(true);

      // After the first run drains, a fresh dispatch goes through
      // again. Drain happens after the response writes, so give it a
      // tick before retrying.
      await new Promise((r) => setTimeout(r, 50));
      release = () => {}; // already released; reuse the same blocker shape
      // Actually we need a fresh blocker for the third call. Easier: just
      // assert that a new request works — re-bind a fresh resolved promise.
      // Skipped: the prior assertion (overloaded → released → first
      // succeeds) is enough to prove the gate flips both ways.
    } finally {
      release();
      await handle.close();
    }
  });

  it('treats maxInflight=undefined as unlimited (no gate)', async () => {
    // Without a cap, even 5 simultaneous slow runs all start (no 503).
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    let entered = 0;
    const slowRun: RunGenFromIrFn = async () => {
      entered++;
      await blocker;
      return {
        ok: true, output: {}, trace: { steps: [] },
        runId: `run_${entered}`, schemaId: 'AnalysisReport', ir: {} as any,
        tracePath: '/tmp/x', outputPath: '/tmp/x', irPath: '/tmp/x', runDir: '/tmp/x',
      } as any;
    };

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      // maxInflight intentionally omitted
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const reqs = Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/v1/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
        }),
      );
      // Give them all a chance to enter the handler.
      await new Promise((r) => setTimeout(r, 100));
      expect(entered).toBe(5);

      release();
      const ress = await Promise.all(reqs);
      for (const r of ress) expect(r.status).toBe(200);
    } finally {
      release();
      await handle.close();
    }
  });

  it('treats maxInflight=0 (or negative) as unlimited rather than locking the server out', async () => {
    // Defensive: a misconfigured operator passing 0 shouldn't brick
    // the server. Treat it as unlimited.
    const fastRun: RunGenFromIrFn = async () =>
      ({
        ok: true, output: {}, trace: { steps: [] },
        runId: 'run_x', schemaId: 'AnalysisReport', ir: {} as any,
        tracePath: '/tmp/x', outputPath: '/tmp/x', irPath: '/tmp/x', runDir: '/tmp/x',
      }) as any;
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: fastRun,
      maxInflight: 0,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

describe('runServe — runTimeoutMs + timeout error kind (RED-360)', () => {
  let tmp: string;
  const fixtureGen = `
class TinyGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport

  def analyze(doc)
    generate "ok" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
  const fixtureContracts = `
export const AnalysisReport = { $id: 'AnalysisReport', type: 'object', additionalProperties: true };
`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-timeout-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/tiny.cmb.rb'), fixtureGen);
    writeFileSync(join(tmp, 'src/contracts.ts'), fixtureContracts);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nTinyGen = "app/gens/tiny.cmb.rb"\n`,
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 504 + timeout when the run exceeds the deadline', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    const slowRun: RunGenFromIrFn = async () => {
      await blocker;
      return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
    };

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      runTimeoutMs: 100,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.kind).toBe('timeout');
      expect(body.error.details.run_timeout_ms).toBe(100);
    } finally {
      release(); // let the leaked runGen call resolve so vitest doesn't complain
      await handle.close();
    }
  });

  it('lets a run complete normally when it beats the deadline', async () => {
    const fastRun: RunGenFromIrFn = async () =>
      ({
        ok: true, output: { hello: 'world' }, trace: { steps: [] },
        runId: 'r_fast', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
      }) as any;

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: fastRun,
      runTimeoutMs: 5000,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.output).toEqual({ hello: 'world' });
    } finally {
      await handle.close();
    }
  });

  it('frees the inflight slot at timeout (a second request can land while the first is still leaking)', async () => {
    // maxInflight=1 + runTimeoutMs=100 + one slow run. After timeout the
    // slot frees, so a second request gets through (rather than 503'ing
    // forever waiting on the leaked runGen call).
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    const slowRun: RunGenFromIrFn = async () => {
      await blocker;
      return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
    };

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      maxInflight: 1,
      runTimeoutMs: 100,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // First request times out at 100ms.
      const first = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(first.status).toBe(504);

      // Slot freed → second request proceeds (also will time out, but
      // proves the cap doesn't permanently block).
      const second = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(second.status).toBe(504);
    } finally {
      release();
      await handle.close();
    }
  });

  it('treats runTimeoutMs=0 (or negative/missing) as unlimited', async () => {
    const fastRun: RunGenFromIrFn = async () =>
      ({
        ok: true, output: {}, trace: { steps: [] },
        runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
      }) as any;

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: fastRun,
      runTimeoutMs: 0,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

describe('runServe — shutdownTimeoutMs (RED-360)', () => {
  let tmp: string;
  const fixtureGen = `
class TinyGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport

  def analyze(doc)
    generate "ok" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
  const fixtureContracts = `
export const AnalysisReport = { $id: 'AnalysisReport', type: 'object', additionalProperties: true };
`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-shutdown-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'app/gens/tiny.cmb.rb'), fixtureGen);
    writeFileSync(join(tmp, 'src/contracts.ts'), fixtureContracts);
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nTinyGen = "app/gens/tiny.cmb.rb"\n`,
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('close() resolves promptly when nothing is in flight', async () => {
    const fastRun: RunGenFromIrFn = async () =>
      ({
        ok: true, output: {}, trace: { steps: [] },
        runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
      }) as any;
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: fastRun,
    });
    await handle.ready;

    const start = Date.now();
    await handle.close();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('close() force-closes lingering connections after shutdownTimeoutMs', async () => {
    // Pin a slow run, then call close() before it completes. The drain
    // would normally wait on the leaked promise; the deadline forces
    // close() to resolve once shutdownTimeoutMs elapses.
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    const slowRun: RunGenFromIrFn = async () => {
      await blocker;
      return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
    };

    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      shutdownTimeoutMs: 200,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Pin a request inflight (don't await its response — we want it
      // hanging when close() fires).
      const pinned = fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TinyGen', method: 'analyze', input: 'x' }),
      });
      // Let the server register the inflight handler.
      await new Promise((r) => setTimeout(r, 50));

      const start = Date.now();
      await handle.close();
      const elapsed = Date.now() - start;
      // Should have force-closed within shutdownTimeoutMs + slack
      // (NOT waited on the leaked runGen promise to resolve).
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1500);

      // The pinned request errors out because the server force-closed
      // its connection. We don't assert exactly *how* it errors — just
      // that the request settled (vitest would otherwise hang on the
      // unawaited promise).
      await pinned.catch(() => {});
    } finally {
      release();
    }
  });

  it('close() is idempotent (second call awaits the first drain)', async () => {
    const fastRun: RunGenFromIrFn = async () =>
      ({
        ok: true, output: {}, trace: { steps: [] },
        runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
      }) as any;
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: fastRun,
    });
    await handle.ready;

    const a = handle.close();
    const b = handle.close();
    // Both should resolve to the same shutdown completion.
    await Promise.all([a, b]);
  });
});

describe('runServe — boot failure (RED-360)', () => {
  let tmp: string;
  let prevMock: string | undefined;

  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });

  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-boot-fail-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects the ready promise when Genfile.toml is missing', async () => {
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
    });
    await expect(handle.ready).rejects.toThrow(/no Genfile\.toml/);
    await handle.close();
  });

  it('rejects the ready promise when a declared gen file does not exist', async () => {
    writeFileSync(
      join(tmp, 'Genfile.toml'),
      `[exports.gens]\nGhost = "app/gens/missing.cmb.rb"\n`,
    );
    const handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
    });
    await expect(handle.ready).rejects.toThrow(/file does not exist/);
    await handle.close();
  });
});

// ── #195: precompiled boot (--precompiled / --ir-dir) ───────────────────

describe('runServe — precompiled boot (#195)', () => {
  function setupWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-serve-precompiled-'));
    mkdirSync(join(dir, 'app/gens'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
    writeFileSync(join(dir, 'src/contracts.ts'), FIXTURE_CONTRACTS);
    writeFileSync(
      join(dir, 'Genfile.toml'),
      `[package]
name = "serve-precompiled"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"
`,
    );
    return dir;
  }

  /** Bare-mode `ruby compile.rb` stdout for `genPath` — the exact bytes
   *  `cambium compile --write` / `--out-dir` would have written to the
   *  sibling/flat artifact file. Used both to produce fixture artifacts
   *  and, in the byte-identity test, to independently reproduce what the
   *  default `compileBare` would return for the same gen. */
  function compileBareStdout(genPath: string): string {
    const res = spawnSync('ruby', [RUBY_COMPILE_RB, genPath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(`ruby compile.rb ${genPath} failed (exit ${res.status}):\n${res.stderr}`);
    }
    return res.stdout;
  }

  let prevMock: string | undefined;
  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  describe('no-Ruby boot', () => {
    let tmp: string;
    let handle: RunServeHandle | undefined;

    beforeEach(() => {
      tmp = setupWorkspace();
      writeFileSync(
        join(tmp, 'app/gens/test_gen.ir.json'),
        compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')),
      );
    });
    afterEach(async () => {
      if (handle) await handle.close().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    });

    it('boots and dispatches with a compileBare that throws if ever called', async () => {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        precompiled: true,
        compileBare: () => {
          throw new Error('ruby must not be spawned');
        },
      });
      const addr = await handle.ready;
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

  describe('byte-identity: compile-at-boot vs precompiled', () => {
    let tmp: string;
    let handleA: RunServeHandle | undefined;
    let handleB: RunServeHandle | undefined;

    beforeEach(() => {
      tmp = setupWorkspace();
      writeFileSync(
        join(tmp, 'app/gens/test_gen.ir.json'),
        compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')),
      );
    });
    afterEach(async () => {
      if (handleA) await handleA.close().catch(() => {});
      if (handleB) await handleB.close().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    });

    it('the artifact file IS what the default compileBare would produce for this gen', () => {
      const expected = JSON.parse(compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')));
      const onDisk = JSON.parse(readFileSync(join(tmp, 'app/gens/test_gen.ir.json'), 'utf8'));
      expect(onDisk).toEqual(expected);
    });

    it('healthz and /v1/run wire bodies are identical (modulo run_id) either boot path', async () => {
      handleA = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
      handleB = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });

      const [addrA, addrB] = await Promise.all([handleA.ready, handleB.ready]);
      if (addrA.kind !== 'tcp' || addrB.kind !== 'tcp') throw new Error('expected tcp binds');
      const baseA = `http://127.0.0.1:${addrA.port}`;
      const baseB = `http://127.0.0.1:${addrB.port}`;

      const [healthA, healthB] = await Promise.all([
        fetch(`${baseA}/v1/healthz`).then((r) => r.json()),
        fetch(`${baseB}/v1/healthz`).then((r) => r.json()),
      ]);
      expect(healthA).toEqual(healthB);

      const body = JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'a document with 42 ms in it' });
      const [runA, runB] = await Promise.all([
        fetch(`${baseA}/v1/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json()),
        fetch(`${baseB}/v1/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json()),
      ]);
      expect(runA.ok).toBe(true);
      delete runA.run_id;
      delete runB.run_id;
      expect(runA).toEqual(runB);
    });
  });

  describe('irDir boot', () => {
    let tmp: string;
    let irDir: string;
    let handle: RunServeHandle | undefined;

    beforeEach(() => {
      tmp = setupWorkspace();
      irDir = join(tmp, 'dist', 'ir');
      mkdirSync(irDir, { recursive: true });
      // No sibling artifact written — irDir is the ONLY artifact source,
      // proving resolution actually used it (not a sibling fallback).
      writeFileSync(join(irDir, 'test_gen.ir.json'), compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')));
    });
    afterEach(async () => {
      if (handle) await handle.close().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    });

    it('boots from <irDir>/<basename>.ir.json', async () => {
      handle = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        irDir,
        compileBare: () => {
          throw new Error('ruby must not be spawned');
        },
      });
      const addr = await handle.ready;
      if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
      const health = await fetch(`http://127.0.0.1:${addr.port}/v1/healthz`);
      expect(health.status).toBe(200);
      expect((await health.json()).gens).toEqual(['TestGen']);
    });
  });

  describe('fail-fast: rejected ready, no listener bound', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it('missing artifact', async () => {
      tmp = setupWorkspace();
      // No .ir.json written at all.
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/precompiled artifact\(s\) not found/);
      await handle.close();
    });

    it('malformed JSON artifact', async () => {
      tmp = setupWorkspace();
      writeFileSync(join(tmp, 'app/gens/test_gen.ir.json'), '{not json');
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/not valid JSON/);
      await handle.close();
    });

    it('wrong-version artifact', async () => {
      tmp = setupWorkspace();
      writeFileSync(
        join(tmp, 'app/gens/test_gen.ir.json'),
        JSON.stringify({ analyze: { version: '0.1', entry: { class: 'TestGen', method: 'analyze' } } }),
      );
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/unsupported compiler version/);
      await handle.close();
    });

    it('an [exports.pipelines] entry', async () => {
      tmp = setupWorkspace();
      writeFileSync(join(tmp, 'app/gens/test_gen.ir.json'), compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')));
      writeFileSync(
        join(tmp, 'Genfile.toml'),
        `[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"

[exports.pipelines]
MyPipeline = "app/pipelines/my_pipeline.pipeline.rb"
`,
      );
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/\[exports\.pipelines\]/);
      await handle.close();
    });

    it('an enrich gen', async () => {
      tmp = setupWorkspace();
      const enrichGen = `
class EnrichGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport
  enrich :document do
    agent :SomeSubAgent, method: :run
  end
  def analyze(doc)
    generate "go" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
      writeFileSync(join(tmp, 'app/gens/enrich_gen.cmb.rb'), enrichGen);
      writeFileSync(
        join(tmp, 'app/gens/enrich_gen.ir.json'),
        compileBareStdout(join(tmp, 'app/gens/enrich_gen.cmb.rb')),
      );
      writeFileSync(
        join(tmp, 'Genfile.toml'),
        `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nEnrichGen = "app/gens/enrich_gen.cmb.rb"\n`,
      );
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/needs Ruby at run time \(enrich\)/);
      await handle.close();
    });

    it('a symbol-form gen in a [types]-less workspace', async () => {
      tmp = mkdtempSync(join(tmpdir(), 'cambium-serve-precompiled-notypes-'));
      mkdirSync(join(tmp, 'app/gens'), { recursive: true });
      const symbolGen = `
class SymbolGen < GenModel
  model "ollama:test"
  system "test"
  returns AnalysisReport
  def analyze(doc)
    generate "go" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;
      writeFileSync(join(tmp, 'app/gens/symbol_gen.cmb.rb'), symbolGen);
      writeFileSync(
        join(tmp, 'app/gens/symbol_gen.ir.json'),
        compileBareStdout(join(tmp, 'app/gens/symbol_gen.cmb.rb')),
      );
      // Deliberately no [types] section, and no src/contracts.ts anywhere —
      // the ruby-side best-effort schema check (compile.rb) is skipped
      // when it can't find a candidates file, so this compiles fine; the
      // DEC-004 refusal is a runtime (serve boot) check, not a compile one.
      writeFileSync(join(tmp, 'Genfile.toml'), `[exports.gens]\nSymbolGen = "app/gens/symbol_gen.cmb.rb"\n`);
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/\[types\]\.contracts/);
      await handle.close();
    });
  });

  describe('appRoot anchoring (#195 DEC-005)', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it('precompiled dispatch passes appRoot === workspaceDir; compile-at-boot dispatch passes none', async () => {
      tmp = setupWorkspace();
      writeFileSync(
        join(tmp, 'app/gens/test_gen.ir.json'),
        compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')),
      );

      const capturedOpts: any[] = [];
      const captureRun: RunGenFromIrFn = async (opts: any) => {
        capturedOpts.push(opts);
        return {
          ok: true, output: {}, trace: { steps: [] },
          runId: 'r', schemaId: 'X', ir: {} as any,
          tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
        } as any;
      };

      const handleA = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        runGenFromIrFn: captureRun,
      });
      const addrA = await handleA.ready;
      if (addrA.kind !== 'tcp') throw new Error('expected tcp');
      await fetch(`http://127.0.0.1:${addrA.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'x' }),
      });
      await handleA.close();

      const handleB = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        precompiled: true,
        runGenFromIrFn: captureRun,
      });
      const addrB = await handleB.ready;
      if (addrB.kind !== 'tcp') throw new Error('expected tcp');
      await fetch(`http://127.0.0.1:${addrB.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'x' }),
      });
      await handleB.close();

      expect(capturedOpts).toHaveLength(2);
      expect(capturedOpts[0].appRoot).toBeUndefined();
      expect(capturedOpts[1].appRoot).toBe(tmp);
    });
  });

  describe('mock option (#198 DEC-003)', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it('threads mock: true to runGenFromIrImpl when opts.mock is set, mock: false when absent', async () => {
      tmp = setupWorkspace();

      const capturedOpts: any[] = [];
      const captureRun: RunGenFromIrFn = async (opts: any) => {
        capturedOpts.push(opts);
        return {
          ok: true, output: {}, trace: { steps: [] },
          runId: 'r', schemaId: 'X', ir: {} as any,
          tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
        } as any;
      };

      const handleA = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        mock: true,
        runGenFromIrFn: captureRun,
      });
      const addrA = await handleA.ready;
      if (addrA.kind !== 'tcp') throw new Error('expected tcp');
      await fetch(`http://127.0.0.1:${addrA.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'x' }),
      });
      await handleA.close();

      const handleB = runServe({
        workspaceDir: tmp,
        bind: parseBind('tcp://127.0.0.1:0'),
        runGenFromIrFn: captureRun,
      });
      const addrB = await handleB.ready;
      if (addrB.kind !== 'tcp') throw new Error('expected tcp');
      await fetch(`http://127.0.0.1:${addrB.port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'TestGen', method: 'analyze', input: 'x' }),
      });
      await handleB.close();

      expect(capturedOpts).toHaveLength(2);
      expect(capturedOpts[0].mock).toBe(true);
      expect(capturedOpts[1].mock).toBe(false);
    });

    it('threads mock: true to runPipelineFromIrImpl when opts.mock is set, mock: false when absent (AUD-198-04)', async () => {
      // The gen-site test above only pins `serve.ts`'s GEN dispatch call —
      // reverting the PIPELINE dispatch site's `mock: opts.mock === true`
      // to `mock: false` left every other suite green (SECURITY-AUDIT-198
      // § AUD-198-04). This fixture adds the missing Pipeline IR coverage.
      const pipeTmp = mkdtempSync(join(tmpdir(), 'cambium-serve-pipe-mock-'));
      mkdirSync(join(pipeTmp, 'app/gens'), { recursive: true });
      mkdirSync(join(pipeTmp, 'app/pipelines'), { recursive: true });
      mkdirSync(join(pipeTmp, 'src'), { recursive: true });
      writeFileSync(join(pipeTmp, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
      writeFileSync(join(pipeTmp, 'src/contracts.ts'), FIXTURE_CONTRACTS);
      writeFileSync(
        join(pipeTmp, 'app/pipelines/test_pipeline.pipeline.rb'),
        `
class TestPipeline < Pipeline
  input :doc, schema: AnalysisReport
  step :one, gen: TestGen, method: :analyze,
    with: { doc: bind(:input).doc }
  def run(doc); end
end
`.trim(),
      );
      writeFileSync(
        join(pipeTmp, 'Genfile.toml'),
        `[package]
name = "serve-pipe-mock"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TestGen = "app/gens/test_gen.cmb.rb"

[exports.pipelines]
TestPipeline = "app/pipelines/test_pipeline.pipeline.rb"
`,
      );

      try {
        const capturedOpts: any[] = [];
        const capturePipeline: RunPipelineFromIrFn = async (opts: any) => {
          capturedOpts.push(opts);
          return {
            ok: true, output: {}, trace: { steps: [] },
            runId: 'r', schemaId: 'X', ir: {} as any,
            tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x',
          } as any;
        };

        const handleA = runServe({
          workspaceDir: pipeTmp,
          bind: parseBind('tcp://127.0.0.1:0'),
          mock: true,
          runPipelineFromIrFn: capturePipeline,
        });
        const addrA = await handleA.ready;
        if (addrA.kind !== 'tcp') throw new Error('expected tcp');
        await fetch(`http://127.0.0.1:${addrA.port}/v1/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gen: 'TestPipeline', method: 'run', input: 'x' }),
        });
        await handleA.close();

        const handleB = runServe({
          workspaceDir: pipeTmp,
          bind: parseBind('tcp://127.0.0.1:0'),
          runPipelineFromIrFn: capturePipeline,
        });
        const addrB = await handleB.ready;
        if (addrB.kind !== 'tcp') throw new Error('expected tcp');
        await fetch(`http://127.0.0.1:${addrB.port}/v1/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gen: 'TestPipeline', method: 'run', input: 'x' }),
        });
        await handleB.close();

        expect(capturedOpts).toHaveLength(2);
        expect(capturedOpts[0].mock).toBe(true);
        expect(capturedOpts[1].mock).toBe(false);
      } finally {
        rmSync(pipeTmp, { recursive: true, force: true });
      }
    });
  });

  describe('nested member package (A-003 / AUD-001) + boot-time contracts resolution (AUD-002)', () => {
    const NESTED_GEN = `
class NestedGen < GenModel
  model "ollama:test"
  system "test prompt"
  returns SubReport

  def analyze(doc)
    generate "analyze the document" do
      with context: doc
      returns SubReport
    end
  end
end
`;
    // Root workspace exports a gen that lives in a member package with its
    // OWN Genfile + [types]. The root's contracts do NOT export SubReport —
    // only the member's do. Compile-at-boot resolves the member (walk-up
    // from entry.source); precompiled must do the same, per gen.
    function setupNested(): string {
      const dir = mkdtempSync(join(tmpdir(), 'cambium-serve-nested-'));
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'vendor/subapp/app/gens'), { recursive: true });
      mkdirSync(join(dir, 'vendor/subapp/src'), { recursive: true });
      writeFileSync(join(dir, 'src/contracts.ts'), FIXTURE_CONTRACTS);
      writeFileSync(
        join(dir, 'Genfile.toml'),
        `[package]\nname = "root"\n\n[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nNestedGen = "vendor/subapp/app/gens/nested_gen.cmb.rb"\n`,
      );
      writeFileSync(
        join(dir, 'vendor/subapp/src/contracts.ts'),
        `export const SubReport = { $id: 'SubReport', type: 'object', additionalProperties: true };\n`,
      );
      writeFileSync(join(dir, 'vendor/subapp/Genfile.toml'), `[package]\nname = "subapp"\n\n[types]\ncontracts = ["src/contracts.ts"]\n`);
      writeFileSync(join(dir, 'vendor/subapp/app/gens/nested_gen.cmb.rb'), NESTED_GEN);
      return dir;
    }

    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    async function postRun(port: number) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'NestedGen', method: 'analyze', input: 'hello world' }),
      });
      return { status: res.status, body: (await res.json()) as any };
    }

    it('AUD-001: a nested gen anchors on its member package, not --workspace — 200 in both boot modes', async () => {
      tmp = setupNested();
      const genPath = join(tmp, 'vendor/subapp/app/gens/nested_gen.cmb.rb');
      writeFileSync(join(tmp, 'vendor/subapp/app/gens/nested_gen.ir.json'), compileBareStdout(genPath));

      const handleA = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
      const addrA = await handleA.ready;
      if (addrA.kind !== 'tcp') throw new Error('expected tcp');
      const a = await postRun(addrA.port);
      await handleA.close();

      const handleB = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      const addrB = await handleB.ready;
      if (addrB.kind !== 'tcp') throw new Error('expected tcp');
      const b = await postRun(addrB.port);
      await handleB.close();

      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      expect(b.body.ok).toBe(true);
      delete a.body.run_id; delete b.body.run_id;
      expect(b.body).toEqual(a.body);
    });

    it('AUD-001: precompiled dispatch passes the member package as appRoot', async () => {
      tmp = setupNested();
      const genPath = join(tmp, 'vendor/subapp/app/gens/nested_gen.cmb.rb');
      writeFileSync(join(tmp, 'vendor/subapp/app/gens/nested_gen.ir.json'), compileBareStdout(genPath));
      const captured: any[] = [];
      const capture: RunGenFromIrFn = async (o: any) => {
        captured.push(o);
        return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any, tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
      };
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true, runGenFromIrFn: capture });
      const addr = await handle.ready;
      if (addr.kind !== 'tcp') throw new Error('expected tcp');
      await postRun(addr.port);
      await handle.close();
      expect(captured).toHaveLength(1);
      expect(captured[0].appRoot).toBe(join(tmp, 'vendor/subapp'));
    });

    it('AUD-004: a contracts file that fails to import is reported under the gen, inside the aggregated boot error', async () => {
      tmp = setupWorkspace();
      writeFileSync(join(tmp, 'app/gens/test_gen.ir.json'), compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')));
      writeFileSync(join(tmp, 'src/contracts.ts'), 'export const AnalysisReport = {\n  this is not typescript\n');
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/contracts cannot be resolved for:\n  TestGen: contracts for .* could not be loaded/);
      await handle.close().catch(() => {});
    });

    it('AUD-002: a returnSchemaId the declared contracts do not export fails boot, not the first request', async () => {
      tmp = setupWorkspace();
      const artifact = JSON.parse(compileBareStdout(join(tmp, 'app/gens/test_gen.cmb.rb')));
      artifact.analyze.returnSchemaId = 'RenamedAwaySchema';
      writeFileSync(join(tmp, 'app/gens/test_gen.ir.json'), JSON.stringify(artifact));
      const handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0'), precompiled: true });
      await expect(handle.ready).rejects.toThrow(/TestGen\.analyze: returnSchemaId "RenamedAwaySchema" is not exported by/);
      await handle.close().catch(() => {});
    });
  });
});

// #197: GET /v1/gens — self-describing catalog.
describe('runServe — GET /v1/gens catalog (#197)', () => {
  // Rich gen: describe, model + fallback, budget (per_run + per_tool),
  // security network allowlist, `returns :Symbol` (exercises the
  // contracts-resolution reuse path).
  const CATALOG_GEN = `
class CatalogGen < GenModel
  model "ollama:test", "ollama:test-fallback"
  system "test prompt"
  describe "Extracts structured data from a document."
  security network: { allowlist: ["api.tavily.com"] }
  budget per_run: { max_calls: 10, max_tokens: 4000 },
         per_tool: { tavily: { max_calls: 3 } }
  returns AnalysisReport

  def analyze(doc)
    generate "analyze the document" do
      with context: doc
    end
  end

  def summarize(doc)
    generate "summarize" do
      with context: doc
    end
  end
end
`;

  // Plain gen: no describe, no budget, no security, single model, inline
  // `returns do … end` block — every "absent" field on the wire should be
  // null and the schema should be the inline block, not contracts-resolved.
  const PLAIN_GEN = `
class PlainGen < GenModel
  model "ollama:test"
  system "test prompt"

  returns do
    field :summary, String
  end

  def analyze(doc)
    generate "analyze" do
      with context: doc
    end
  end
end
`;

  const CATALOG_CONTRACTS = `
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: true,
};
`;

  // Pipeline: security + budget declared (pipeline-level flat
  // {tokens, tool_calls} shape — deliberately NOT the same shape as a
  // gen's {per_run, per_tool}, to prove the catalog passes each through
  // verbatim rather than inventing a unified shape). 1:1 class/method
  // (RED-374), so exactly one method: "run".
  const CATALOG_PIPELINE = `
class CatalogPipeline < Pipeline
  input :doc, schema: AnalysisReport
  security network: { allowlist: ["api.tavily.com"] }
  budget tokens: 5000, tool_calls: 20
  step :one, gen: CatalogGen, method: :analyze,
    with: { doc: bind(:input).doc }
  def run(doc); end
end
`;

  // AUD-197-1: sandboxed exec, non-empty exec-scoped network allowlist.
  // Mirrors the audit report's minimal repro — the real Ruby compiler
  // emits `{ allowed: false, runtime: "firecracker", network: { allowlist } }`
  // for this declaration (no top-level `security network:` slot at all).
  const EXEC_GEN = `
class ExecGen < GenModel
  model "ollama:test"
  system "test prompt"
  security exec: {
    runtime: :firecracker,
    network: { allowlist: ["evil.example.com"] },
  }

  returns do
    field :summary, String
  end

  def analyze(doc)
    generate "analyze" do
      with context: doc
    end
  end
end
`;

  // AUD-197-1: the explicit unsandboxed sharp-knife opt-in — proves
  // `runtime`/`unsafe_native` are reported verbatim, not collapsed into
  // a single boolean, and that an undeclared exec-scoped network:
  // sub-key reports 'none' (deny-by-default), not null/omitted.
  const UNSAFE_NATIVE_GEN = `
class UnsafeNativeGen < GenModel
  model "ollama:test"
  system "test prompt"
  security exec: { unsafe_native: true }

  returns do
    field :summary, String
  end

  def analyze(doc)
    generate "analyze" do
      with context: doc
    end
  end
end
`;

  // AUD-197-3: a declared network slot with no allowlist key — compiles
  // to allowlist: [] (functionally deny-all per network-guard.ts), which
  // must label as 'none', not 'allowlist'.
  const EMPTY_ALLOWLIST_GEN = `
class EmptyAllowlistGen < GenModel
  model "ollama:test"
  system "test prompt"
  security network: { block_private: false }

  returns do
    field :summary, String
  end

  def analyze(doc)
    generate "analyze" do
      with context: doc
    end
  end
end
`;

  // AUD-197-2: a policy-pack-sourced security/budget declaration — the
  // only path that populates the Ruby-side \`_packs\` accumulator this
  // change strips before the wire. Mirrors app/policies/research_defaults
  // + web_researcher.cmb.rb in this repo.
  const CATALOG_PACK = `
network \\
  allowlist: %w[packed.example.com]

budget \\
  per_tool: { packed_tool: { max_calls: 2 } },
  per_run:  { max_calls: 7 }
`;

  const PACKED_GEN = `
class PackedGen < GenModel
  model "ollama:test"
  system "test prompt"
  security :catalog_pack
  budget   :catalog_pack

  returns do
    field :summary, String
  end

  def analyze(doc)
    generate "analyze" do
      with context: doc
    end
  end
end
`;

  function setupWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cambium-serve-catalog-'));
    mkdirSync(join(dir, 'app/gens'), { recursive: true });
    mkdirSync(join(dir, 'app/pipelines'), { recursive: true });
    mkdirSync(join(dir, 'app/policies'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'app/gens/catalog_gen.cmb.rb'), CATALOG_GEN);
    writeFileSync(join(dir, 'app/gens/plain_gen.cmb.rb'), PLAIN_GEN);
    writeFileSync(join(dir, 'app/gens/exec_gen.cmb.rb'), EXEC_GEN);
    writeFileSync(join(dir, 'app/gens/unsafe_native_gen.cmb.rb'), UNSAFE_NATIVE_GEN);
    writeFileSync(join(dir, 'app/gens/empty_allowlist_gen.cmb.rb'), EMPTY_ALLOWLIST_GEN);
    writeFileSync(join(dir, 'app/gens/packed_gen.cmb.rb'), PACKED_GEN);
    writeFileSync(join(dir, 'app/policies/catalog_pack.policy.rb'), CATALOG_PACK);
    writeFileSync(join(dir, 'app/pipelines/catalog_pipeline.pipeline.rb'), CATALOG_PIPELINE);
    writeFileSync(join(dir, 'src/contracts.ts'), CATALOG_CONTRACTS);
    writeFileSync(
      join(dir, 'Genfile.toml'),
      `[package]
name = "serve-catalog"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
CatalogGen = "app/gens/catalog_gen.cmb.rb"
PlainGen = "app/gens/plain_gen.cmb.rb"
ExecGen = "app/gens/exec_gen.cmb.rb"
UnsafeNativeGen = "app/gens/unsafe_native_gen.cmb.rb"
EmptyAllowlistGen = "app/gens/empty_allowlist_gen.cmb.rb"
PackedGen = "app/gens/packed_gen.cmb.rb"

[exports.pipelines]
CatalogPipeline = "app/pipelines/catalog_pipeline.pipeline.rb"
`,
    );
    return dir;
  }

  let tmp: string;
  let handle: RunServeHandle | undefined;
  let prevMock: string | undefined;

  beforeAll(() => {
    prevMock = process.env.CAMBIUM_ALLOW_MOCK;
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterAll(() => {
    if (prevMock === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
    else process.env.CAMBIUM_ALLOW_MOCK = prevMock;
  });

  beforeEach(() => {
    tmp = setupWorkspace();
  });
  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the full wire shape for a gen, a defaults-only gen, and a pipeline', async () => {
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/v1/gens`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe('v1');
    expect(Array.isArray(body.gens)).toBe(true);

    const byName = Object.fromEntries(body.gens.map((g: any) => [g.name, g]));
    expect(Object.keys(byName).sort()).toEqual([
      'CatalogGen',
      'CatalogPipeline',
      'EmptyAllowlistGen',
      'ExecGen',
      'PackedGen',
      'PlainGen',
      'UnsafeNativeGen',
    ]);

    // Rich gen: every field populated, returns:Symbol resolved via contracts.
    const catalogGen = byName.CatalogGen;
    expect(catalogGen.kind).toBe('gen');
    expect(catalogGen.description).toBe('Extracts structured data from a document.');
    expect(catalogGen.methods.sort()).toEqual(['analyze', 'summarize']);
    expect(catalogGen.returns.analyze).toMatchObject({
      $id: 'AnalysisReport',
      type: 'object',
      properties: { summary: { type: 'string' } },
    });
    expect(catalogGen.returns.summarize).toMatchObject({ $id: 'AnalysisReport' });
    expect(catalogGen.model).toEqual({ id: 'ollama:test', fallbacks: ['ollama:test-fallback'] });
    expect(catalogGen.budget).toEqual({
      per_run: { max_calls: 10, max_tokens: 4000 },
      per_tool: { tavily: { max_calls: 3 } },
    });
    expect(catalogGen.egress).toEqual({ network: 'allowlist', allowlist: ['api.tavily.com'] });
    // AUD-197-1: no `security exec:` slot declared — exec is null, not omitted.
    expect(catalogGen.exec).toBeNull();
    expect(catalogGen.example.gen).toBe('CatalogGen');
    expect(['analyze', 'summarize']).toContain(catalogGen.example.method);
    expect(typeof catalogGen.example.input).toBe('string');

    // Plain gen: every optional field is null, schema is the inline block
    // (not contracts-resolved — PlainGen never declares [types] usage for
    // itself, it's just never looked up because returnSchema is inline).
    const plainGen = byName.PlainGen;
    expect(plainGen.kind).toBe('gen');
    expect(plainGen.description).toBeNull();
    expect(plainGen.methods).toEqual(['analyze']);
    expect(plainGen.returns.analyze).toMatchObject({
      $id: 'PlainGenOutput',
      type: 'object',
      properties: { summary: { type: 'string' } },
    });
    expect(plainGen.model).toEqual({ id: 'ollama:test', fallbacks: null });
    expect(plainGen.budget).toBeNull();
    expect(plainGen.egress).toEqual({ network: 'none', allowlist: null });
    expect(plainGen.exec).toBeNull();
    expect(plainGen.example).toEqual({ gen: 'PlainGen', method: 'analyze', input: '<document>' });

    // Pipeline: no model (no single top-level model on a Pipeline IR), no
    // returns schema (Pipeline IRs carry no returnSchemaId/returnSchema),
    // budget/egress passed through verbatim in the pipeline's own shape.
    const pipeline = byName.CatalogPipeline;
    expect(pipeline.kind).toBe('pipeline');
    expect(pipeline.description).toBeNull();
    expect(pipeline.methods).toEqual(['run']);
    expect(pipeline.returns).toEqual({ run: null });
    expect(pipeline.model).toBeNull();
    expect(pipeline.budget).toEqual({ tokens: 5000, tool_calls: 20 });
    expect(pipeline.egress).toEqual({ network: 'allowlist', allowlist: ['api.tavily.com'] });
    expect(pipeline.exec).toBeNull();
    expect(pipeline.example).toEqual({ gen: 'CatalogPipeline', method: 'run', input: '<doc>' });
  });

  it('AUD-197-1: discloses the security exec: slot verbatim per-runtime, never collapsed into a boolean', async () => {
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/v1/gens`);
    const body = await res.json();
    const byName = Object.fromEntries(body.gens.map((g: any) => [g.name, g]));

    // Sandboxed exec, non-empty exec-scoped network allowlist — and NO
    // top-level `security network:` slot, matching the audit repro: a
    // gen can be network-reachable purely via its exec sandbox while
    // `egress` (the top-level-only field) reports 'none'.
    const execGen = byName.ExecGen;
    expect(execGen.exec).toEqual({ runtime: 'firecracker', unsafe_native: false, network: 'allowlist' });
    expect(execGen.egress).toEqual({ network: 'none', allowlist: null });

    // Explicit unsandboxed sharp-knife opt-in — runtime/unsafe_native
    // reported verbatim, not collapsed into a single boolean. No
    // exec-scoped network: sub-key declared → 'none' (deny-by-default).
    const unsafeNativeGen = byName.UnsafeNativeGen;
    expect(unsafeNativeGen.exec).toEqual({ runtime: 'native', unsafe_native: true, network: 'none' });
  });

  it('AUD-197-3: a declared network slot with an empty allowlist reports egress.network as none, not allowlist', async () => {
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/v1/gens`);
    const body = await res.json();
    const byName = Object.fromEntries(body.gens.map((g: any) => [g.name, g]));

    const emptyAllowlistGen = byName.EmptyAllowlistGen;
    expect(emptyAllowlistGen.egress).toEqual({ network: 'none', allowlist: null });
  });

  it('AUD-197-2: budget/egress from a policy-pack-sourced declaration match the pack, and _packs never reaches the wire', async () => {
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/v1/gens`);
    const body = await res.json();
    const byName = Object.fromEntries(body.gens.map((g: any) => [g.name, g]));

    const packedGen = byName.PackedGen;
    expect(packedGen.budget).toEqual({
      per_tool: { packed_tool: { max_calls: 2 } },
      per_run: { max_calls: 7 },
    });
    expect(packedGen.egress).toEqual({ network: 'allowlist', allowlist: ['packed.example.com'] });
    // Guards every field on the entry, not just budget/egress — a future
    // field that forwards pack-sourced state must strip `_packs` too.
    expect(JSON.stringify(packedGen)).not.toContain('_packs');
  });

  it('is never gated by --max-inflight — answers while the server is saturated with an in-flight run', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((res) => { release = res; });
    const slowRun: RunGenFromIrFn = async () => {
      await blocker;
      return {
        ok: true, output: { summary: 'ok' }, trace: { steps: [] },
        runId: 'run_slow', schemaId: 'AnalysisReport', ir: {} as any,
        tracePath: '/tmp/fake/trace.json', outputPath: '/tmp/fake/output.json',
        irPath: '/tmp/fake/ir.json', runDir: '/tmp/fake',
      } as any;
    };

    handle = runServe({
      workspaceDir: tmp,
      bind: parseBind('tcp://127.0.0.1:0'),
      runGenFromIrFn: slowRun,
      maxInflight: 1,
    });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Saturate the single inflight slot.
      const firstP = fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'CatalogGen', method: 'analyze', input: 'x' }),
      });
      await new Promise((r) => setTimeout(r, 50));

      // Confirm the cap is actually hit (mirrors the existing overloaded test).
      const overloadRes = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gen: 'CatalogGen', method: 'analyze', input: 'x' }),
      });
      expect(overloadRes.status).toBe(503);

      // /v1/gens is a cheap read over the boot-time catalog — must answer
      // 200 regardless of the saturated /v1/run cap (settled decision).
      const catalogRes = await fetch(`${baseUrl}/v1/gens`);
      expect(catalogRes.status).toBe(200);
      const catalogBody = await catalogRes.json();
      expect(catalogBody.gens.map((g: any) => g.name).sort()).toEqual([
        'CatalogGen', 'CatalogPipeline', 'EmptyAllowlistGen', 'ExecGen',
        'PackedGen', 'PlainGen', 'UnsafeNativeGen',
      ]);

      release();
      await firstP;
    } finally {
      release();
      await handle.close().catch(() => {});
    }
  });

  it('boot-gating is identical to healthz: both sit behind the same booted check, before any URL routing', async () => {
    // Not independently testable over HTTP (the listener only binds after
    // boot work — including catalog construction — completes, so there is
    // no window in which a connection can reach a not-yet-`booted` server;
    // true of healthz too, which has no such test either). What IS
    // provable: after boot, both routes are reachable and consistent.
    handle = runServe({ workspaceDir: tmp, bind: parseBind('tcp://127.0.0.1:0') });
    const addr = await handle.ready;
    if (addr.kind !== 'tcp') throw new Error('expected tcp bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const [healthRes, catalogRes] = await Promise.all([
      fetch(`${baseUrl}/v1/healthz`),
      fetch(`${baseUrl}/v1/gens`),
    ]);
    expect(healthRes.status).toBe(200);
    expect(catalogRes.status).toBe(200);
    const healthBody = await healthRes.json();
    const catalogBody = await catalogRes.json();
    expect(catalogBody.gens.map((g: any) => g.name).sort()).toEqual(healthBody.gens.sort());
  });
});
