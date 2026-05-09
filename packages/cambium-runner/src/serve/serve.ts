/**
 * RED-360 phase 1: `cambium serve` HTTP server core.
 *
 * Long-lived runner over HTTP. Boots once, dispatches many requests
 * against pre-compiled IRs cached in memory. The transport layer for
 * non-Node hosts (FastAPI, Django, Go, Elixir, ...) — wire format is
 * locked at v1, see `docs/GenDSL Docs/RFC - Serve Mode [DRAFT].md`.
 *
 * Boot:
 *   1. Load the gen catalog (Genfile.toml [exports.gens] → file paths).
 *   2. For each gen, spawn `ruby compile.rb <path>` in bare mode and
 *      cache every (method → IR) pair. Compile failures fail boot
 *      (no half-loaded server).
 *   3. Bind the HTTP listener and resolve `ready`.
 *
 * Per-request:
 *   - GET  /v1/healthz → status + gen list (503 during boot).
 *   - POST /v1/run     → look up cached IR, inject input, dispatch via
 *                         runGenFromIr, return JSON envelope.
 *   - Anything else    → 404.
 *
 * Out of scope for this slice (deferred to follow-up commits per the
 * RFC's Phase 1 plan): the full error.kind matrix, memory handle
 * pool, `--max-inflight`, fancy shutdown drain. Minimum viable error
 * surface (`unknown_gen`, `unknown_method`, `input_invalid`,
 * `runner_error`) is wired so callers don't get bare 500s on
 * predictable failures.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenFromIr, type IR } from '../runner.js';
import { loadGenCatalog, type GenCatalog } from './gen-catalog.js';
import type { BindTarget } from './bind.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cambium-runner/src/serve/serve.ts → workspace root (up 4 levels).
const DEFAULT_COMPILE_RB = pathResolve(__dirname, '../../../..', 'ruby/cambium/compile.rb');

const SERVE_VERSION = 'v1';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Compile a `.cmb.rb` in bare mode and return its method → IR map.
 * Defaults to spawning the in-tree `ruby compile.rb`. Override for tests.
 */
export type CompileBareFn = (genFilePath: string) => Promise<Record<string, IR>>;

export interface RunServeOptions {
  /** Path to the workspace containing `Genfile.toml`. */
  workspaceDir: string;
  /** Parsed bind target from `parseBind`. */
  bind: BindTarget;
  /** Override the compile fn (default spawns ruby compile.rb in bare mode). */
  compileBare?: CompileBareFn;
  /** Override the runtime cwd passed to runGenFromIr. Defaults to workspaceDir. */
  runCwd?: string;
}

export type RunServeAddress =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; path: string }
  | { kind: 'pipe'; pipePath: string };

export interface RunServeHandle {
  /** Resolves once boot completes and the server is accepting connections. */
  ready: Promise<RunServeAddress>;
  /** Drain in-flight calls and close. Idempotent. */
  close(): Promise<void>;
}

export function runServe(opts: RunServeOptions): RunServeHandle {
  const compileBare = opts.compileBare ?? defaultCompileBare;
  const runCwd = opts.runCwd ?? opts.workspaceDir;

  // Per-(gen, method) IR cache populated at boot. Map<gen, Map<method, IR>>.
  const cache = new Map<string, Map<string, IR>>();
  let booted = false;
  let catalogRef: GenCatalog | null = null;

  const inflight = new Set<Promise<unknown>>();
  let closing = false;

  // Boot: load catalog → compile each gen → start listening.
  let server: Server | null = null;
  const ready = (async (): Promise<RunServeAddress> => {
    const catalog = loadGenCatalog(opts.workspaceDir);
    catalogRef = catalog;

    for (const [name, entry] of catalog.entries) {
      const irMap = await compileBare(entry.genFilePath);
      const methodMap = new Map<string, IR>();
      for (const [method, ir] of Object.entries(irMap)) {
        methodMap.set(method, ir);
      }
      cache.set(name, methodMap);
    }

    server = createServer((req, res) => handleRequest(req, res));
    await listen(server, opts.bind);
    booted = true;
    return addressOf(server, opts.bind);
  })();

  // Surface boot errors clearly: an unhandled rejection at this layer
  // would crash the process; we want the caller (CLI) to log and exit.
  ready.catch(() => {
    /* swallow — caller awaits ready and handles rejection */
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Boot still running: 503 on everything except a healthz probe so
    // orchestrators can see the server is up but not ready yet.
    if (!booted) {
      sendJson(res, 503, {
        ok: false,
        error: { kind: 'booting', message: 'cambium serve is still loading gens' },
      });
      return;
    }

    const { method, url } = req;
    if (method === 'GET' && url === `/${SERVE_VERSION}/healthz`) {
      sendJson(res, 200, {
        status: 'ok',
        gens: catalogRef ? Array.from(catalogRef.entries.keys()) : [],
        version: SERVE_VERSION,
      });
      return;
    }

    if (method === 'POST' && url === `/${SERVE_VERSION}/run`) {
      const p = handleRun(req, res).catch((err) => {
        // Last-resort guard: any error not caught downstream becomes a
        // generic runner_error envelope. The richer error.kind matrix
        // lands in the next slice.
        sendJson(res, 500, {
          ok: false,
          error: { kind: 'runner_error', message: errorMessage(err) },
        }).catch(() => {});
      });
      let tracked!: Promise<unknown>;
      tracked = (async () => {
        try {
          await p;
        } finally {
          inflight.delete(tracked);
        }
      })();
      inflight.add(tracked);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: { kind: 'not_found', message: `no route for ${method} ${url}` },
    });
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      await sendJson(res, 400, {
        ok: false,
        error: { kind: 'input_invalid', message: errorMessage(err) },
      });
      return;
    }

    const { gen, method, input } = body ?? {};
    if (typeof gen !== 'string' || gen.length === 0) {
      await sendJson(res, 400, {
        ok: false,
        error: { kind: 'input_invalid', message: 'body.gen must be a non-empty string' },
      });
      return;
    }
    if (typeof method !== 'string' || method.length === 0) {
      await sendJson(res, 400, {
        ok: false,
        error: { kind: 'input_invalid', message: 'body.method must be a non-empty string' },
      });
      return;
    }

    const methodMap = cache.get(gen);
    if (!methodMap) {
      await sendJson(res, 400, {
        ok: false,
        error: {
          kind: 'unknown_gen',
          message: `gen '${gen}' is not in this server's catalog`,
          details: { available: Array.from(cache.keys()) },
        },
      });
      return;
    }
    const cachedIr = methodMap.get(method);
    if (!cachedIr) {
      await sendJson(res, 400, {
        ok: false,
        error: {
          kind: 'unknown_method',
          message: `gen '${gen}' has no method '${method}'`,
          details: { available: Array.from(methodMap.keys()) },
        },
      });
      return;
    }

    // Clone the cached IR so we don't mutate the canonical copy when
    // injecting per-call input. JSON round-trip is the cheapest deep-clone
    // for IR (plain JSON objects throughout).
    const ir = JSON.parse(JSON.stringify(cachedIr)) as IR;
    injectInput(ir, input);

    let result;
    try {
      result = await runGenFromIr({
        ir,
        cwd: runCwd,
        memoryKeys: Array.isArray(body.memory_keys)
          ? body.memory_keys
          : memoryKeysFromObject(body.memory_keys),
        firedBy: typeof body.fired_by === 'string' ? body.fired_by : undefined,
      });
    } catch (err) {
      await sendJson(res, 500, {
        ok: false,
        error: { kind: 'runner_error', message: errorMessage(err) },
      });
      return;
    }

    const includeTrace = body.include_trace === true;
    const responseBody: Record<string, unknown> = {
      ok: result.ok,
      run_id: result.runId ?? null,
      output: result.output ?? null,
    };
    if (!result.ok && result.errorMessage) {
      responseBody.error = { kind: 'runner_error', message: result.errorMessage };
    }
    if (includeTrace && result.tracePath) {
      // Trace inline opt-in — read from disk rather than holding the
      // full trace in memory across the whole run.
      try {
        const fs = await import('node:fs/promises');
        responseBody.trace = JSON.parse(await fs.readFile(result.tracePath, 'utf8'));
      } catch (err) {
        responseBody.trace_error = errorMessage(err);
      }
    }

    await sendJson(res, result.ok ? 200 : 500, responseBody);
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;

    if (!server) {
      return;
    }

    // Stop accepting new connections. server.close() finishes when all
    // connections are closed.
    const closed = new Promise<void>((res, rej) => {
      server!.close((err) => (err ? rej(err) : res()));
    });

    // Drain in-flight handlers up to the timeout.
    const drain = Promise.allSettled(Array.from(inflight));
    const timeout = new Promise<void>((res) => setTimeout(res, SHUTDOWN_TIMEOUT_MS));
    await Promise.race([drain, timeout]);
    await closed.catch(() => {});
  }

  return { ready, close };
}

// ── HTTP plumbing ──────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  return new Promise((resolveP) => {
    if (res.headersSent) return resolveP();
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload, () => resolveP());
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectP(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        rejectP(new Error('empty request body'));
        return;
      }
      try {
        resolveP(JSON.parse(raw));
      } catch (e: any) {
        rejectP(new Error(`malformed JSON: ${e?.message ?? String(e)}`));
      }
    });
    req.on('error', rejectP);
  });
}

function listen(server: Server, bind: BindTarget): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    server.once('error', rejectP);
    const onListen = () => {
      server.off('error', rejectP);
      resolveP();
    };
    switch (bind.kind) {
      case 'tcp':
        server.listen(bind.port, bind.host, onListen);
        return;
      case 'unix':
        server.listen(bind.path, onListen);
        return;
      case 'pipe':
        server.listen(bind.pipePath, onListen);
        return;
    }
  });
}

function addressOf(server: Server, bind: BindTarget): RunServeAddress {
  if (bind.kind === 'tcp') {
    const a = server.address();
    if (a && typeof a === 'object') {
      return { kind: 'tcp', host: a.address, port: a.port };
    }
    return { kind: 'tcp', host: bind.host, port: bind.port };
  }
  if (bind.kind === 'unix') return { kind: 'unix', path: bind.path };
  return { kind: 'pipe', pipePath: bind.pipePath };
}

// ── input injection + helpers ─────────────────────────────────────

function injectInput(ir: IR, input: unknown): void {
  // The compile-time IR has exactly one context key (set by compile.rb,
  // either `grounded_in :name` source or the default 'document'). Per-call
  // input overrides it.
  const ctx = (ir as any).context;
  if (!ctx || typeof ctx !== 'object') return;
  const keys = Object.keys(ctx);
  if (keys.length === 0) return;
  const key = keys[0];
  if (typeof input === 'string') {
    ctx[key] = input;
  } else if (input === undefined || input === null) {
    ctx[key] = '';
  } else {
    // dicts/lists JSON-stringify so the runner sees a string in context,
    // matching the existing `cambium run --arg <file>` convention.
    ctx[key] = JSON.stringify(input);
  }
}

function memoryKeysFromObject(obj: unknown): string[] | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  return Object.entries(obj as Record<string, unknown>).map(
    ([k, v]) => `${k}=${String(v)}`,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── default Ruby compile-bare ─────────────────────────────────────

function defaultCompileBare(genFilePath: string): Promise<Record<string, IR>> {
  return Promise.resolve().then(() => {
    const result = spawnSync('ruby', [DEFAULT_COMPILE_RB, genFilePath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(
        `ruby compile.rb ${genFilePath} failed (exit ${result.status}):\n` +
          (result.stderr ?? ''),
      );
    }
    try {
      return JSON.parse(result.stdout) as Record<string, IR>;
    } catch (e: any) {
      throw new Error(
        `failed to parse compile.rb output for ${genFilePath}: ${e?.message ?? String(e)}`,
      );
    }
  });
}
