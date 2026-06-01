import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInspect, type InspectHandle } from './server.js';

// RED-313: server API + guards. Spins a real server on an ephemeral port
// (host 127.0.0.1, port 0) and exercises the JSON API + path-traversal guard
// against a tmp runs/ seeded with a captured fixture trace.

const FX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const genTrace = readFileSync(join(FX, 'gen-linear.trace.json'), 'utf8');
const pipeTrace = readFileSync(join(FX, 'pipeline-fanout.trace.json'), 'utf8');

let workspace: string;
let runsDir: string;
let handle: InspectHandle;

function seedRun(id: string, traceJson: string, output?: unknown): void {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace.json'), traceJson);
  if (output !== undefined) writeFileSync(join(dir, 'output.json'), JSON.stringify(output));
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'cambium-inspect-'));
  runsDir = join(workspace, 'runs');
  mkdirSync(runsDir, { recursive: true });
  seedRun('run_20260101_000000_aaaaaa', genTrace, { summary: 'hi' });
  seedRun('run_20260101T000001Z_bbbbbb', pipeTrace);
  handle = await runInspect({ runsDir, host: '127.0.0.1', port: 0, publicDir: PUBLIC });
});
afterEach(async () => {
  await handle.close();
  rmSync(workspace, { recursive: true, force: true });
});

const get = (p: string) => fetch(handle.url + p);

describe('cambium inspect server', () => {
  it('GET /api/runs lists seeded runs newest-first with summaries', async () => {
    const { runs } = await get('/api/runs').then((r) => r.json());
    expect(runs).toHaveLength(2);
    const ids = runs.map((r: any) => r.id);
    expect(ids).toContain('run_20260101_000000_aaaaaa');
    expect(runs.find((r: any) => r.kind === 'pipeline')).toBeTruthy();
    expect(runs.find((r: any) => r.kind === 'gen')).toBeTruthy();
  });

  it('GET /api/runs/:id returns the projected graph model + output', async () => {
    const res = await get('/api/runs/run_20260101_000000_aaaaaa');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model.kind).toBe('gen');
    expect(body.model.nodes.length).toBeGreaterThan(1);
    expect(body.output).toEqual({ summary: 'hi' });
  });

  it('GET /api/runs/:id 404s an unknown run', async () => {
    const res = await get('/api/runs/run_does_not_exist');
    expect(res.status).toBe(404);
  });

  it('rejects a path-traversal id without touching the filesystem', async () => {
    // Encoded ../ — the run-id regex rejects it; must not 200 or escape runsDir.
    const res = await get('/api/runs/' + encodeURIComponent('../../etc/passwd'));
    expect(res.status).toBe(404);
    const malformed = await get('/api/runs/..%2F..%2Fsecret');
    expect([400, 404]).toContain(malformed.status);
  });

  it('rejects a static-asset path-traversal', async () => {
    const res = await get('/..%2F..%2F..%2Fetc%2Fpasswd');
    // Either bad-path (400) or not-found (404) — never a 200 with file contents.
    expect([400, 404]).toContain(res.status);
  });

  it('serves the viewer index.html at /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/cambium inspect/);
  });

  it('exposes an SSE events endpoint', async () => {
    const res = await get('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await res.body?.cancel(); // close the stream so the test can finish
  });
});
