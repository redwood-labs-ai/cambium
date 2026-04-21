/**
 * RED-302: log backend unit tests.
 *
 * Each backend is a LogSink; tests exercise the happy path and the
 * key failure modes (missing endpoint, missing API key, non-2xx response).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { stdout } from './stdout.js';
import { http_json } from './http_json.js';
import { datadog, mapDatadogStatus } from './datadog.js';
import type { LogEvent, LogDestination } from '../event.js';

function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    event_name: 'pattern_extractor.extract.complete',
    gen: 'pattern_extractor',
    method: 'extract',
    event: 'complete',
    run_id: 'run_test_123',
    ok: true,
    duration_ms: 1234,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    trace_ref: 'runs/run_test_123/trace.json',
    ...overrides,
  };
}

describe('stdout log backend', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints a single line per event with event_name prefix', async () => {
    await stdout(makeEvent(), {
      destination: 'stdout',
      include: [],
      granularity: 'run',
    });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = String(stderrSpy.mock.calls[0][0]);
    expect(line).toMatch(/^\[pattern_extractor\.extract\.complete\]/);
    expect(line).toContain('ok=true');
    expect(line).toContain('duration_ms=1234');
  });

  it('JSON-encodes nested objects like usage', async () => {
    await stdout(makeEvent(), {
      destination: 'stdout',
      include: [],
      granularity: 'run',
    });
    const line = String(stderrSpy.mock.calls[0][0]);
    expect(line).toMatch(/usage=\{/);
  });

  it('skips undefined/null fields', async () => {
    await stdout(
      makeEvent({ duration_ms: undefined, reason: undefined }),
      { destination: 'stdout', include: [], granularity: 'run' },
    );
    const line = String(stderrSpy.mock.calls[0][0]);
    expect(line).not.toContain('duration_ms=');
    expect(line).not.toContain('reason=');
  });
});

describe('http_json log backend', () => {
  let server: Server;
  let url: string;
  let captured: Array<{ path: string; headers: Record<string, any>; body: any }>;

  beforeEach(async () => {
    captured = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          headers: req.headers as Record<string, any>,
          body: body ? JSON.parse(body) : null,
        });
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/ingest`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('POSTs a JSON body to the configured endpoint', async () => {
    await http_json(makeEvent(), {
      destination: 'http_json',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe('/ingest');
    expect(captured[0].headers['content-type']).toBe('application/json');
    expect(captured[0].body.event_name).toBe('pattern_extractor.extract.complete');
  });

  it('sends Bearer auth when api_key_env is set', async () => {
    process.env.TEST_LOG_KEY = 'secret-abc';
    try {
      await http_json(makeEvent(), {
        destination: 'http_json',
        include: [],
        granularity: 'run',
        endpoint: url,
        api_key_env: 'TEST_LOG_KEY',
      });
      expect(captured[0].headers.authorization).toBe('Bearer secret-abc');
    } finally {
      delete process.env.TEST_LOG_KEY;
    }
  });

  it('throws when endpoint is missing', async () => {
    await expect(
      http_json(makeEvent(), { destination: 'http_json', include: [], granularity: 'run' }),
    ).rejects.toThrow(/missing endpoint/);
  });

  it('throws on non-2xx response so the runner records LogFailed', async () => {
    const failingUrl = url.replace('/ingest', '/404');
    // Swap server to return 404 for this test.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((_req, res) => { res.statusCode = 500; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(
      http_json(makeEvent(), {
        destination: 'http_json',
        include: [],
        granularity: 'run',
        endpoint: `http://127.0.0.1:${port}/`,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('datadog log backend', () => {
  let server: Server;
  let url: string;
  let captured: Array<{ headers: Record<string, any>; body: any }>;

  beforeEach(async () => {
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
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/api/v2/logs`;
    process.env.CAMBIUM_DATADOG_API_KEY = 'dd-key-abc';
  });

  afterEach(async () => {
    delete process.env.CAMBIUM_DATADOG_API_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sets ddsource and ddtags from the event', async () => {
    await datadog(makeEvent(), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].body.ddsource).toBe('cambium');
    expect(captured[0].body.ddtags).toBe(
      'gen:pattern_extractor,method:extract,event:complete,ok:true',
    );
  });

  it('includes reason in ddtags when present', async () => {
    await datadog(
      makeEvent({ event: 'failed', ok: false, reason: 'budget_exceeded' }),
      { destination: 'datadog', include: [], granularity: 'run', endpoint: url },
    );
    expect(captured[0].body.ddtags).toMatch(/reason:budget_exceeded/);
    expect(captured[0].body.ddtags).toMatch(/ok:false/);
  });

  it('flattens usage.* into usage_* top-level fields', async () => {
    await datadog(makeEvent(), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].body.usage).toBeUndefined();
    expect(captured[0].body.usage_prompt_tokens).toBe(100);
    expect(captured[0].body.usage_completion_tokens).toBe(50);
    expect(captured[0].body.usage_total_tokens).toBe(150);
  });

  it('sets DD-API-KEY header from the configured env var', async () => {
    await datadog(makeEvent(), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].headers['dd-api-key']).toBe('dd-key-abc');
  });

  it('throws clearly when API key env var is unset', async () => {
    delete process.env.CAMBIUM_DATADOG_API_KEY;
    await expect(
      datadog(makeEvent(), {
        destination: 'datadog',
        include: [],
        granularity: 'run',
        endpoint: url,
      }),
    ).rejects.toThrow(/CAMBIUM_DATADOG_API_KEY env var not set/);
  });

  it('sets service field from the gen name', async () => {
    await datadog(makeEvent(), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].body.service).toBe('pattern_extractor');
  });

  it('sets status=info on complete events so DD severity facets work', async () => {
    await datadog(makeEvent({ event: 'complete', ok: true }), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].body.status).toBe('info');
  });

  it('sets status=warn on complete_with_warnings events', async () => {
    await datadog(makeEvent({ event: 'complete_with_warnings', ok: true }), {
      destination: 'datadog',
      include: [],
      granularity: 'run',
      endpoint: url,
    });
    expect(captured[0].body.status).toBe('warn');
  });

  it('sets status=error on failed events so monitor queries key off status', async () => {
    await datadog(
      makeEvent({ event: 'failed', ok: false, reason: 'validation_failed' }),
      { destination: 'datadog', include: [], granularity: 'run', endpoint: url },
    );
    expect(captured[0].body.status).toBe('error');
  });
});

describe('mapDatadogStatus (RED-302 follow-up: severity mapping)', () => {
  const baseEvent: LogEvent = {
    event_name: 'g.m.complete',
    gen: 'g',
    method: 'm',
    event: 'complete',
    run_id: 'r',
    ok: true,
  };

  it('complete → info', () => {
    expect(mapDatadogStatus({ ...baseEvent, event: 'complete' })).toBe('info');
  });

  it('complete_with_warnings → warn', () => {
    expect(mapDatadogStatus({ ...baseEvent, event: 'complete_with_warnings' })).toBe('warn');
  });

  it('failed → error regardless of reason', () => {
    for (const reason of ['budget_exceeded', 'validation_failed', 'schema_broke_after_corrector', 'error'] as const) {
      expect(
        mapDatadogStatus({ ...baseEvent, event: 'failed', ok: false, reason }),
      ).toBe('error');
    }
  });

  it('correct_accepted_with_errors step → warn (unhealed-but-shippable)', () => {
    expect(
      mapDatadogStatus({ ...baseEvent, event: 'correct_accepted_with_errors' }),
    ).toBe('warn');
  });

  it('unrecognized step events default to info (safe default for run-progress steps)', () => {
    expect(mapDatadogStatus({ ...baseEvent, event: 'tool_call' })).toBe('info');
    expect(mapDatadogStatus({ ...baseEvent, event: 'repair' })).toBe('info');
    expect(mapDatadogStatus({ ...baseEvent, event: 'signal_fired' })).toBe('info');
  });
});

describe('log backend SSRF guard (RED-302 follow-up)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_DATADOG_API_KEY = 'dd-key';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_DATADOG_API_KEY;
  });

  it('blocks http_json endpoints pointing at AWS metadata service', async () => {
    await expect(
      http_json(makeEvent(), {
        destination: 'http_json',
        include: [],
        granularity: 'run',
        endpoint: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow(/blocked.*block_metadata/);
  });

  it('blocks datadog endpoints pointing at GCP metadata service', async () => {
    await expect(
      datadog(makeEvent(), {
        destination: 'datadog',
        include: [],
        granularity: 'run',
        endpoint: 'http://metadata.google.internal/computeMetadata/v1/',
      }),
    ).rejects.toThrow(/blocked.*block_metadata/);
  });

  it('allows http_json endpoints on RFC1918 private ranges (internal ingest)', async () => {
    // Spin a quick localhost server — 127.0.0.1 is technically loopback
    // (blocked by block_private), but we disable block_private for log
    // endpoints. Confirm the request reaches it.
    const server = createServer((_req, res) => { res.statusCode = 200; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        http_json(makeEvent(), {
          destination: 'http_json',
          include: [],
          granularity: 'run',
          endpoint: `http://127.0.0.1:${port}/`,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
