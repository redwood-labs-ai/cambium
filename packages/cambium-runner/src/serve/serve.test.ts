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
import { runServe, type RunServeHandle } from './serve.js';

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
