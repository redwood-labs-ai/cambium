/**
 * RED-302: end-to-end log primitive integration test.
 *
 * Spins up a mock Datadog intake server, builds a tmpdir workspace
 * with a log profile + a gen that declares `log :test_default`, runs
 * the full CLI under --mock, and asserts that:
 *
 *   - One event reaches the mock server.
 *   - event_name is `<snake_gen>.<method>.complete`.
 *   - ddsource + ddtags match the expected shape.
 *   - Framework-always fields (run_id, ok, duration_ms, usage) present.
 *   - trace.json shows a LogEmitted step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const FIXTURE = join(REPO_ROOT, 'packages/cambium/examples/fixtures/incident.txt');

let scratch: string;
let server: Server;
let captured: Array<{ headers: Record<string, any>; body: any }>;
let mockUrl: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-red302-e2e-'));
  captured = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured.push({
        headers: req.headers as Record<string, any>,
        body: body ? JSON.parse(body) : null,
      });
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  mockUrl = `http://127.0.0.1:${port}/api/v2/logs`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

// Async CLI runner — spawnSync would block the event loop and prevent
// our mock HTTP server (in the same Node worker) from accepting the
// subprocess's fetch. Using spawn lets the event loop tick.
function runCliAsync(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr });
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function setupWorkspace(logBody: string, profileBody?: string): string {
  // Lay out `<scratch>/app/log_profiles/*.log_profile.rb` directly as a
  // sibling of the gen's parent dir — the gen lives at `<scratch>/g.cmb.rb`
  // and `_cambium_discovery_dirs` walks from the gen file, picking up
  // `<scratch>/log_profiles/*.log_profile.rb` (layer 2: gen_dir's
  // sibling <subdir>) or a sibling `app/log_profiles/` (layer 1+).
  // Placing the profile next to the gen at `<scratch>/log_profiles/`
  // works for both layouts. We use the app-style nesting for clarity.
  if (profileBody) {
    const profilesDir = join(scratch, 'log_profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      join(profilesDir, 'test_default.log_profile.rb'),
      profileBody.trim(),
    );
  }

  const genPath = join(scratch, 'gens', 'my_gen.cmb.rb');
  mkdirSync(join(scratch, 'gens'), { recursive: true });
  writeFileSync(
    genPath,
    `
class MyGen < GenModel
  model "omlx:stub"
  system "inline"
  returns AnalysisReport
  ${logBody}

  def analyze(input)
    generate "go" do
      with context: input
      returns AnalysisReport
    end
  end
end
`.trim(),
  );
  return genPath;
}

describe('log primitive E2E (RED-302)', () => {
  it('profile form: log :test_default routes to datadog + stdout', async () => {
    const profile = `
destination :datadog, endpoint: "${mockUrl}", api_key_env: "CAMBIUM_DATADOG_API_KEY"
destination :stdout
include :signals
granularity :run
    `;
    const genPath = setupWorkspace('log :test_default', profile);
    const traceOut = join(scratch, 'trace.json');

    const result = await runCliAsync(
      [
        'run', genPath,
        '--method', 'analyze',
        '--arg', FIXTURE,
        '--mock',
        '--trace', traceOut,
        '--out', join(scratch, 'output.json'),
      ],
      {
        CAMBIUM_ALLOW_MOCK: '1',
        CAMBIUM_DATADOG_API_KEY: 'mock-dd-key',
      },
    );

    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('CLI exit status:', result.status);
      console.error('stderr:', result.stderr);
      console.error('stdout:', result.stdout);
    }
    expect(result.status).toBe(0);

    // Mock DD server should have received exactly one event.
    expect(captured).toHaveLength(1);
    const event = captured[0].body;
    expect(event.ddsource).toBe('cambium');
    expect(event.ddtags).toMatch(/gen:my_gen/);
    expect(event.ddtags).toMatch(/method:analyze/);
    expect(event.ddtags).toMatch(/event:complete/);
    expect(event.ddtags).toMatch(/ok:true/);
    expect(event.event_name).toBe('my_gen.analyze.complete');
    expect(event.run_id).toMatch(/^run_/);
    expect(event.ok).toBe(true);
    expect(event.schema_id).toBe('AnalysisReport');
    // Usage flattened for DD:
    expect(event.usage).toBeUndefined();
    expect(event.usage_total_tokens).toBeTypeOf('number');

    // Header auth:
    expect(captured[0].headers['dd-api-key']).toBe('mock-dd-key');

    // Stderr should carry the stdout backend's readable line:
    expect(result.stderr).toMatch(/\[my_gen\.analyze\.complete\]/);

    // Trace should record LogEmitted for datadog + stdout.
    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const logEmittedSteps = trace.steps.filter((s: any) => s.type === 'LogEmitted');
    expect(logEmittedSteps).toHaveLength(2);
    const destinations = logEmittedSteps.map((s: any) => s.meta.destination).sort();
    expect(destinations).toEqual(['datadog', 'stdout']);
  });

  it('inline form: log :datadog with endpoint + api_key_env', async () => {
    const genPath = setupWorkspace(
      `log :datadog, endpoint: "${mockUrl}", api_key_env: "CAMBIUM_DATADOG_API_KEY"`,
    );
    const traceOut = join(scratch, 'trace.json');

    const result = await runCliAsync(
      [
        'run', genPath,
        '--method', 'analyze',
        '--arg', FIXTURE,
        '--mock',
        '--trace', traceOut,
        '--out', join(scratch, 'output.json'),
      ],
      {
        CAMBIUM_ALLOW_MOCK: '1',
        CAMBIUM_DATADOG_API_KEY: 'mock-dd-key',
      },
    );

    expect(result.status).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.event_name).toBe('my_gen.analyze.complete');
  });

  it('sink failure becomes a LogFailed step — run still succeeds', async () => {
    // Point datadog at a URL that returns 500 so dispatch fails.
    const failingServer = createServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
    const failingPort = (failingServer.address() as AddressInfo).port;
    const failingUrl = `http://127.0.0.1:${failingPort}/`;

    try {
      const genPath = setupWorkspace(
        `log :datadog, endpoint: "${failingUrl}", api_key_env: "CAMBIUM_DATADOG_API_KEY"`,
      );
      const traceOut = join(scratch, 'trace.json');

      const result = await runCliAsync(
        [
          'run', genPath,
          '--method', 'analyze',
          '--arg', FIXTURE,
          '--mock',
          '--trace', traceOut,
          '--out', join(scratch, 'output.json'),
        ],
        {
          CAMBIUM_ALLOW_MOCK: '1',
          CAMBIUM_DATADOG_API_KEY: 'mock-dd-key',
        },
      );

      // Run should succeed despite DD being down.
      expect(result.status).toBe(0);

      const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
      const logFailedSteps = trace.steps.filter((s: any) => s.type === 'LogFailed');
      expect(logFailedSteps).toHaveLength(1);
      expect(logFailedSteps[0].meta.destination).toBe('datadog');
      expect(logFailedSteps[0].meta.reason).toMatch(/HTTP 500/);
    } finally {
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
    }
  });
});
