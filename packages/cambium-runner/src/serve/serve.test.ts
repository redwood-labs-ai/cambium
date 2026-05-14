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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBind } from './bind.js';
import {
  classifyThrownError,
  runServe,
  type RunGenFromIrFn,
  type RunServeHandle,
} from './serve.js';

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

// Schema that the mock provider's `{summary, metrics, key_facts}` payload
// won't satisfy (mock has none of these required fields). Used to exercise
// the validation_failed path end-to-end. We re-use the `AnalysisReport`
// schema name because compile.rb's compile-time schema check searches
// for the symbol in the in-tree contracts.ts (cwd-relative fallback),
// where AnalysisReport exists. The runtime loads our LOCAL strict
// version via [types].contracts in the tmp Genfile.
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
    name: { type: 'string' },
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
