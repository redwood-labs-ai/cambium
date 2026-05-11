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
import { parseMemoryKeys } from '../memory/keys.js';
import { loadGenCatalog, type GenCatalog } from './gen-catalog.js';
import type { BindTarget } from './bind.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cambium-runner/src/serve/serve.ts → workspace root (up 4 levels).
const DEFAULT_COMPILE_RB = pathResolve(__dirname, '../../../..', 'ruby/cambium/compile.rb');

const SERVE_VERSION = 'v1';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Closed v1 enum (RFC § wire format). Adding a new kind is a v2 break;
 * additive response fields are not. Clients ignore unknown fields.
 */
export type ErrorKind =
  | 'unknown_gen'
  | 'unknown_method'
  | 'input_invalid'
  | 'validation_failed'
  | 'budget_exhausted'
  | 'tool_dispatch_failed'
  | 'runner_error'
  | 'timeout'
  | 'overloaded'
  | 'booting'
  | 'not_found';

/**
 * Classify an error thrown synchronously out of `runGenFromIr`.
 *
 * The runner's pre-flight checks throw plain `Error` instances with
 * stable message prefixes when a gen declares capabilities the runtime
 * can't provide:
 *   - tool registry mismatch  (runner.ts ~line 1020)
 *   - action registry mismatch (runner.ts ~line 1027)
 *   - security violations      (runner.ts ~line 1047)
 *
 * Each of these is a configuration failure rather than a runtime mishap,
 * so we surface them as `tool_dispatch_failed` rather than `runner_error`
 * — clients can distinguish a misconfigured gen from a model/runtime
 * blow-up. Anything else falls through to `runner_error`.
 *
 * Coupled to the runner's exact error wording. If those strings change,
 * the integration tests catch it via the e2e suite + serve.test.ts.
 */
export function classifyThrownError(err: unknown): ErrorKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^Tool ".+" declared in policies\.tools_allowed but not found in registry/.test(msg)) {
    return 'tool_dispatch_failed';
  }
  if (/^Trigger action ".+" not found in ActionRegistry/.test(msg)) {
    return 'tool_dispatch_failed';
  }
  if (/security violation\(s\)/.test(msg)) {
    return 'tool_dispatch_failed';
  }
  return 'runner_error';
}

/**
 * Compile a `.cmb.rb` in bare mode and return its method → IR map.
 * Defaults to spawning the in-tree `ruby compile.rb`. Override for tests.
 */
export type CompileBareFn = (genFilePath: string) => Promise<Record<string, IR>>;

/** Dispatch fn matching `runGenFromIr`'s signature. Injectable for tests. */
export type RunGenFromIrFn = typeof runGenFromIr;

export interface RunServeOptions {
  /** Path to the workspace containing `Genfile.toml`. */
  workspaceDir: string;
  /** Parsed bind target from `parseBind`. */
  bind: BindTarget;
  /** Override the compile fn (default spawns ruby compile.rb in bare mode). */
  compileBare?: CompileBareFn;
  /** Override the dispatch fn (default is the imported runGenFromIr). For tests. */
  runGenFromIrFn?: RunGenFromIrFn;
  /** Override the runtime cwd passed to runGenFromIr. Defaults to workspaceDir. */
  runCwd?: string;
  /**
   * Cap on concurrent /v1/run dispatches. When the in-flight set is at
   * the cap, additional /v1/run requests get a 503 + `error.kind=overloaded`
   * envelope so callers know to back off. Defaults to unlimited. /v1/healthz
   * is never gated. RED-360 wave 2.
   */
  maxInflight?: number;
  /**
   * Per-call deadline. When set, /v1/run races runGenFromIr against this
   * deadline; the loser returns HTTP 504 + `error.kind=timeout`.
   *
   * Honest semantic for v1: the deadline frees the in-flight *slot* and
   * tells the client to stop waiting, but does NOT cancel the underlying
   * runGen call (the runner has no cooperative cancellation in v1). The
   * still-running call eventually resolves and its result is dropped.
   * Document this for operators — a misbehaving long-running gen still
   * burns model spend even after the timeout fires.
   *
   * Defaults to unlimited. RED-360 wave 3.
   */
  runTimeoutMs?: number;
  /**
   * Bound on how long `close()` waits for in-flight runs to drain
   * before force-closing remaining HTTP connections. After this
   * deadline, `server.closeAllConnections()` fires so the close
   * promise actually resolves promptly. Defaults to 30 s. RED-360
   * wave 4.
   */
  shutdownTimeoutMs?: number;
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
  const runGenFromIrImpl = opts.runGenFromIrFn ?? runGenFromIr;
  const runCwd = opts.runCwd ?? opts.workspaceDir;
  // 0 or negative would lock the server out entirely — treat those as
  // "unlimited" rather than "block everything." `Infinity` is the sentinel.
  const maxInflight =
    typeof opts.maxInflight === 'number' && opts.maxInflight > 0
      ? opts.maxInflight
      : Infinity;
  const runTimeoutMs =
    typeof opts.runTimeoutMs === 'number' && opts.runTimeoutMs > 0
      ? opts.runTimeoutMs
      : Infinity;
  const shutdownTimeoutMs =
    typeof opts.shutdownTimeoutMs === 'number' && opts.shutdownTimeoutMs > 0
      ? opts.shutdownTimeoutMs
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;

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
        run_id: null,
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
      // Backpressure: refuse new dispatches once the in-flight cap is
      // hit. /v1/healthz is intentionally never gated — orchestrators
      // need to be able to probe a saturated server.
      if (inflight.size >= maxInflight) {
        sendJson(res, 503, {
          ok: false,
          run_id: null,
          error: {
            kind: 'overloaded' as ErrorKind,
            message: `server is at the in-flight cap (${maxInflight}); retry later`,
            details: { inflight: inflight.size, max_inflight: maxInflight },
          },
        }).catch(() => {});
        return;
      }
      const p = handleRun(req, res).catch((err) => {
        // Last-resort guard: any error not caught downstream becomes a
        // generic runner_error envelope. No run_id is available here —
        // the dispatch never reached runGen.
        sendJson(res, 500, {
          ok: false,
          run_id: null,
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
      run_id: null,
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
        run_id: null,
        error: { kind: 'input_invalid', message: errorMessage(err) },
      });
      return;
    }

    const { gen, method, input } = body ?? {};
    if (typeof gen !== 'string' || gen.length === 0) {
      await sendJson(res, 400, {
        ok: false,
        run_id: null,
        error: { kind: 'input_invalid', message: 'body.gen must be a non-empty string' },
      });
      return;
    }
    if (typeof method !== 'string' || method.length === 0) {
      await sendJson(res, 400, {
        ok: false,
        run_id: null,
        error: { kind: 'input_invalid', message: 'body.method must be a non-empty string' },
      });
      return;
    }

    const methodMap = cache.get(gen);
    if (!methodMap) {
      await sendJson(res, 400, {
        ok: false,
        run_id: null,
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
        run_id: null,
        error: {
          kind: 'unknown_method',
          message: `gen '${gen}' has no method '${method}'`,
          details: { available: Array.from(methodMap.keys()) },
        },
      });
      return;
    }

    // Validate memory_keys at the wire boundary. The same guard fires
    // again inside runGen via parseMemoryKeys → validateSafeSegment, but
    // running it here keeps the invariant visible at the surface (and
    // any future refactor of the runGen → runGenFromIr call path can't
    // silently drop it). cambium-security review (RED-360) flagged the
    // deep-only validation as a defense-in-depth gap.
    const memoryKeys: string[] = Array.isArray(body.memory_keys)
      ? body.memory_keys
      : memoryKeysFromObject(body.memory_keys) ?? [];
    try {
      parseMemoryKeys(memoryKeys);
    } catch (err) {
      await sendJson(res, 400, {
        ok: false,
        run_id: null,
        error: { kind: 'input_invalid', message: errorMessage(err) },
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
      const runP = runGenFromIrImpl({
        ir,
        cwd: runCwd,
        memoryKeys,
        firedBy: typeof body.fired_by === 'string' ? body.fired_by : undefined,
      });

      if (runTimeoutMs === Infinity) {
        result = await runP;
      } else {
        // Race the dispatch against the deadline. The runP path attaches
        // a no-op .catch BEFORE the race so a post-timeout rejection
        // doesn't surface as an unhandled promise rejection.
        runP.catch(() => {});
        let timer: NodeJS.Timeout | undefined;
        const winner = await Promise.race([
          runP.then((r) => ({ kind: 'result' as const, result: r })),
          new Promise<{ kind: 'timeout' }>((res) => {
            timer = setTimeout(() => res({ kind: 'timeout' }), runTimeoutMs);
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (winner.kind === 'timeout') {
          await sendJson(res, 504, {
            ok: false,
            // Timeout fires before the runner returns a runId, so there
            // isn't one to surface here. The leaked run continues in the
            // background; its trace lands at runs/<id>/ but the id is
            // unavailable to the caller.
            run_id: null,
            error: {
              kind: 'timeout' as ErrorKind,
              message: `run did not complete within ${runTimeoutMs} ms`,
              details: { run_timeout_ms: runTimeoutMs },
            },
          });
          return;
        }
        result = winner.result;
      }
    } catch (err) {
      // Errors that escape runGenFromIr are pre-flight or unrecoverable.
      // The runner throws synchronously for unknown tools, missing
      // actions, and security violations — those map to
      // `tool_dispatch_failed`. Anything else is a generic runner_error.
      // No runId is produced for these (the runner aborts before
      // assigning one).
      const kind = classifyThrownError(err);
      await sendJson(res, kind === 'tool_dispatch_failed' ? 400 : 500, {
        ok: false,
        run_id: null,
        error: { kind, message: errorMessage(err) },
      });
      return;
    }

    const includeTrace = body.include_trace === true;
    const responseBody: Record<string, unknown> = {
      ok: result.ok,
      run_id: result.runId ?? null,
      output: result.output ?? null,
    };
    if (!result.ok) {
      // Map runGen's typed `failureKind` (RED-360) to the wire enum.
      // Other ok:false paths (document extraction, etc.) fall through
      // as runner_error.
      const kind: ErrorKind =
        result.failureKind === 'validation' ? 'validation_failed' :
        result.failureKind === 'budget'     ? 'budget_exhausted' :
        'runner_error';
      responseBody.error = {
        kind,
        message: result.errorMessage ?? 'run failed without an explanation',
      };
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

  // Cache the close promise so a second close() awaits the same drain
  // rather than racing in parallel or returning early.
  let closeP: Promise<void> | null = null;
  async function close(): Promise<void> {
    if (closeP) return closeP;
    closing = true;

    if (!server) {
      closeP = Promise.resolve();
      return closeP;
    }

    closeP = (async () => {
      // server.close stops accepting new connections; the callback
      // fires once all open connections are also closed. We wait on
      // both the inflight handlers AND server.close, with a deadline.
      const closed = new Promise<void>((res, rej) => {
        server!.close((err) => (err ? rej(err) : res()));
      });
      // Pre-attach a no-op .catch on closed — if we time out before
      // it resolves, the rejection still surfaces somewhere harmless.
      closed.catch(() => {});

      const drain = Promise.allSettled(Array.from(inflight));

      // .unref() so a fast-draining shutdown isn't held open by the
      // timer for the remainder of the deadline.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((res) => {
        timer = setTimeout(() => res('timeout'), shutdownTimeoutMs);
        timer.unref?.();
      });

      const winner = await Promise.race([
        Promise.all([drain, closed]).then(() => 'drained' as const),
        timeout,
      ]);
      if (timer) clearTimeout(timer);

      if (winner === 'timeout') {
        // Force-close any sockets the runtime is still hanging onto so
        // the close promise actually resolves on a deterministic
        // schedule. closeAllConnections is Node 18.2+.
        server!.closeAllConnections?.();
        // Give server.close a brief moment to finish after the force-
        // close, but don't wait forever.
        await Promise.race([
          closed.catch(() => {}),
          new Promise<void>((res) => {
            const t = setTimeout(res, 100);
            t.unref?.();
          }),
        ]);
      }
    })();

    return closeP;
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
