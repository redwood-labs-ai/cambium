/**
 * #198: `cambium mcp` — MCP-stdio ↔ `/v1`-HTTP adapter.
 *
 * DEC-001 (PLAN-198): this module is a pure adapter, not a second
 * dispatch implementation. It boots `runServe` in-process on a private
 * socket (DEC-002) and speaks plain HTTP to `GET /v1/gens` + `POST
 * /v1/run` over it — every tool the MCP client sees, and every result
 * it gets back, is the same catalog and the same run path `cambium
 * serve` uses. This is what makes `structuredContent.error` a byte-
 * equal relay of the `/v1/run` error envelope (DEC-008): the adapter
 * never re-derives or re-classifies a failure, it only reshapes the
 * envelope MCP's two error channels expect.
 *
 * Framing (DEC-004): newline-delimited JSON-RPC 2.0, no Content-Length
 * headers, no batching (a JSON-array request answers `-32600`). Lines
 * are split by hand (see "stdin line cap + resync" below, DEC-012 —
 * audit round 1) rather than via `node:readline`, so a single-line size
 * cap can be enforced; written one `JSON.stringify`'d line at a time
 * through `writeMessage()` below — `JSON.stringify` never emits a raw
 * newline inside the line it produces, so every write is exactly one
 * frame.
 *
 * stdin line cap + resync (DEC-012, audit round 1, closes security-pass
 * Finding 2): a single stdin line is capped at `MAX_STDIN_LINE_BYTES`
 * (16 MiB — comfortably above the 10 MB `/v1/run` body cap plus JSON-RPC
 * framing overhead, so no legitimate frame is ever refused). Exceeding
 * the cap emits a `-32700`-class error naming the limit and enters
 * discard-until-newline mode for the remainder of that line — bounded
 * memory, no process kill; the very next newline resyncs the stream and
 * normal framing resumes on the line after it.
 *
 * Lifecycle (DEC-009): every message — including `initialize` — is
 * queued behind `ready` (the private-socket boot + catalog fetch), so
 * `booting` never surfaces to an MCP client. Boot failure surfaces as a
 * rejected `ready`; the CLI (`cli/mcp.mjs`) is what turns that into
 * "log to stderr, exit 1" and turns stdin EOF (`handle.closed`) into
 * "exit 0" — mirroring how `cli/serve.mjs` wraps `runServe`. Keeping
 * process-exit decisions out of this module is what lets
 * `opts.input`/`opts.output` unit-test the whole protocol without a
 * real process or real stdio. Likewise, this module never touches the
 * global `console` — the CLI's `console.log = console.error`
 * belt-and-braces rebind (DEC-009) would corrupt unrelated test output
 * if it lived here. DEC-009a (audit round 1) hardens that belt-and-
 * braces one level further, at the CLI layer, by rebinding
 * `process.stdout.write` itself to forward to stderr and handing this
 * module the captured real writer as `opts.output` — see `cli/mcp.mjs`.
 *
 * Protocol hygiene (audit round 1, closes AUD-198-06): a request whose
 * `jsonrpc` field isn't exactly `'2.0'`, or whose `id` isn't a string,
 * number, or `null`, is rejected with `-32600`. Requests answered
 * *before* `initialize` are intentionally still tolerated — see
 * `handleLine` below and `C - MCP Mode.md` § lifecycle.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runServe,
  type CompileBareFn,
  type RunGenFromIrFn,
  type RunPipelineFromIrFn,
  type RunServeHandle,
  type GenCatalogWireEntry,
} from '../serve/serve.js';
import type { BindTarget } from '../serve/bind.js';

// ── version (for `initialize`'s serverInfo) ───────────────────────────

/** `packages/cambium-runner/package.json` lives two levels above this
 *  module in BOTH layouts this file ships in: `src/mcp/mcp-stdio.ts`
 *  (dev/test) and `dist/mcp/mcp-stdio.js` (built/published) both sit
 *  under `<package root>/{src,dist}/mcp/`. Best-effort: a read failure
 *  degrades to `'unknown'` rather than failing boot over a version string. */
function readRunnerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(pathResolve(here, '../../package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
const RUNNER_VERSION = readRunnerVersion();

// ── protocol constants (DEC-005) ──────────────────────────────────────

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

// ── stdin line cap (DEC-012, audit round 1) ────────────────────────────

/** 16 MiB — comfortably above the 10 MB `/v1/run` body cap plus JSON-RPC
 *  framing overhead, so no legitimate frame is ever refused. */
const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024;

// ── public API (DEC-010) ───────────────────────────────────────────────

export interface McpStdioOptions {
  /** Path to the workspace containing `Genfile.toml`. Passed straight
   *  through to `runServe`. */
  workspaceDir: string;
  /** Passed straight through to `runServe` (#195). */
  precompiled?: boolean;
  /** Passed straight through to `runServe` (#195). */
  irDir?: string;
  /** Passed straight through to `runServe` (#198 DEC-003). */
  mock?: boolean;
  /** Passed straight through to `runServe` (RED-376). */
  compileRb?: string;
  /** MCP requests arrive on this stream. Defaults to `process.stdin`.
   *  Injectable so tests can drive the whole protocol without real
   *  stdio (DEC-010). */
  input?: NodeJS.ReadableStream;
  /** MCP responses are written to this stream. Defaults to
   *  `process.stdout`. Injectable for the same reason as `input` — and
   *  the reason `stdout` must otherwise stay protocol-only. */
  output?: NodeJS.WritableStream;
  /** Override the Ruby-compile fn passed to `runServe`. For tests. */
  compileBare?: CompileBareFn;
  /** Override the gen dispatch fn passed to `runServe`. For tests. */
  runGenFromIrFn?: RunGenFromIrFn;
  /** Override the pipeline dispatch fn passed to `runServe`. For tests. */
  runPipelineFromIrFn?: RunPipelineFromIrFn;
}

export interface McpStdioHandle {
  /** Resolves once boot completes: the private socket is bound,
   *  `runServe` is listening on it, and the tool table has been built
   *  from `GET /v1/gens`. Rejects on any boot failure (bad workspace,
   *  a tool-name collision, a socket bind failure, …) — the caller
   *  (`cli/mcp.mjs`) is what turns that into "stderr + exit 1". */
  ready: Promise<void>;
  /** Resolves once shutdown has fully completed — either because the
   *  input stream hit EOF, or because `close()` was called (e.g. from
   *  a signal handler). The caller awaits this before `process.exit(0)`. */
  closed: Promise<void>;
  /** Idempotent programmatic shutdown: closes the underlying `runServe`
   *  handle, removes the private socket directory (POSIX), and resolves
   *  `closed`. */
  close(): Promise<void>;
}

/** One JSON-RPC message id. `null` is a legal id only on error responses
 *  to un-decodable requests (parse error, batch). */
type JsonRpcId = string | number | null;

/** Input-shape classification for a catalog entry's ONE derived
 *  `inputSchema` (DEC-007 — derived per catalog *entry*, shared across
 *  all of the entry's methods; only the tool `description` varies
 *  per method). */
export type InputShape =
  | { mode: 'string'; noun: string }
  | { mode: 'optionalString' }
  | { mode: 'object'; slots: string[] };

export interface ToolTableEntry {
  gen: string;
  method: string;
  shape: InputShape;
  inputSchema: Record<string, unknown>;
  description: string;
  /** Draft-07 schema from the catalog's `returns[method]`, or
   *  `undefined` when the method has no return schema (DEC-008 —
   *  `outputSchema` is omitted from the tool entirely in that case,
   *  never emitted as `null`). */
  outputSchema?: unknown;
}

export function runMcpStdio(opts: McpStdioOptions): McpStdioHandle {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  let toolTable = new Map<string, ToolTableEntry>();
  let socketTarget: string | null = null; // node:http `socketPath` value (unix path or win32 pipe path — A-4)
  let socketDir: string | null = null; // POSIX only; removed on close
  let serveHandle: RunServeHandle | null = null;

  let closing = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>((res) => {
    closedResolve = res;
  });

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      if (serveHandle) await serveHandle.close();
    } finally {
      if (socketDir) {
        try {
          rmSync(socketDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      closedResolve();
    }
  }

  const ready = (async (): Promise<void> => {
    const { bind, socketDir: dir, socketTarget: target } = makePrivateBind();
    socketDir = dir;
    socketTarget = target;

    serveHandle = runServe({
      workspaceDir: opts.workspaceDir,
      bind,
      compileRb: opts.compileRb,
      precompiled: opts.precompiled,
      irDir: opts.irDir,
      mock: opts.mock,
      compileBare: opts.compileBare,
      runGenFromIrFn: opts.runGenFromIrFn,
      runPipelineFromIrFn: opts.runPipelineFromIrFn,
    });
    await serveHandle.ready;

    const catalog = await httpRequestJson<{ version: string; gens: GenCatalogWireEntry[] }>(
      socketTarget,
      'GET',
      '/v1/gens',
    );
    toolTable = buildToolTable(catalog.gens ?? []);
  })();
  // Same posture as runServe's own `ready`: the promise is exposed to the
  // caller via the returned handle; this swallow only prevents an
  // unhandled-rejection warning from the internal reference above.
  ready.catch(() => {});

  function queueLine(line: string): void {
    // DEC-009: every message queues behind boot. A line that arrives
    // before `ready` settles is processed once it does, in the order
    // received; if boot fails, there is no server to answer against —
    // the process is expected to exit before another line matters.
    void ready.then(() => handleLine(line)).catch(() => {});
  }

  // DEC-012 (audit round 1): a hand-rolled line splitter, not
  // `node:readline`, so a single line's size can be capped. `pending`
  // holds bytes accumulated for the in-progress line; `discarding` is
  // true while resyncing past an oversized line (everything up to the
  // next newline is thrown away, unbuffered).
  let pending = Buffer.alloc(0);
  let discarding = false;

  function emitLineTooLong(): void {
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `Parse error: stdin line exceeds the ${MAX_STDIN_LINE_BYTES}-byte (16 MiB) limit; discarding until the next newline`,
      },
    });
  }

  function deliverLine(lineBuf: Buffer): void {
    // Mirror node:readline's CRLF handling — strip a trailing `\r`.
    let end = lineBuf.length;
    if (end > 0 && lineBuf[end - 1] === 0x0d) end -= 1;
    queueLine(lineBuf.subarray(0, end).toString('utf8'));
  }

  function feed(chunk: Buffer): void {
    let buf = chunk;
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a); // '\n'
      if (discarding) {
        if (nl === -1) return; // still discarding; nothing left to resync on
        discarding = false;
        buf = buf.subarray(nl + 1);
        continue;
      }
      if (nl === -1) {
        if (pending.length + buf.length > MAX_STDIN_LINE_BYTES) {
          emitLineTooLong();
          pending = Buffer.alloc(0);
          discarding = true;
          return;
        }
        pending = pending.length === 0 ? Buffer.from(buf) : Buffer.concat([pending, buf]);
        return;
      }
      const rest = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (pending.length + rest.length > MAX_STDIN_LINE_BYTES) {
        emitLineTooLong();
        pending = Buffer.alloc(0);
        continue;
      }
      const lineBuf = pending.length === 0 ? rest : Buffer.concat([pending, rest]);
      pending = Buffer.alloc(0);
      deliverLine(lineBuf);
    }
  }

  // Narrowed explicitly to `NodeJS.ReadableStream` — `input`'s inferred
  // type is a union with `process.stdin`'s (a `ReadStream`), and calling
  // an overloaded method across a union of overloaded function types is
  // a `tsc` union-callability edge case some `@types/node` versions hit
  // harder than others depending on exactly which extra overload
  // `ReadStream` declares.
  const stream = input as NodeJS.ReadableStream;
  stream.on('data', (chunk: Buffer | string) => {
    feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  stream.on('end', () => {
    // node:readline flushes a final incomplete line on EOF; mirror that
    // — unless we're mid-discard, in which case there's nothing legal
    // to flush.
    if (!discarding && pending.length > 0) {
      deliverLine(pending);
      pending = Buffer.alloc(0);
    }
    void close();
  });

  function writeMessage(msg: unknown): void {
    output.write(`${JSON.stringify(msg)}\n`);
  }

  function respond(hasId: boolean, id: JsonRpcId, result: unknown): void {
    if (!hasId) return; // notification — MCP forbids a response
    writeMessage({ jsonrpc: '2.0', id, result });
  }

  function respondError(hasId: boolean, id: JsonRpcId, code: number, message: string): void {
    if (!hasId) return;
    writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    if (Array.isArray(msg)) {
      // DEC-004: MCP 2025-06-18 removed JSON-RPC batching.
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: batch requests are not supported' },
      });
      return;
    }

    if (typeof msg !== 'object' || msg === null || typeof (msg as any).method !== 'string') {
      const maybeId = msg && typeof msg === 'object' && 'id' in (msg as any) ? (msg as any).id : null;
      writeMessage({ jsonrpc: '2.0', id: maybeId ?? null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }

    const rec = msg as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(rec, 'id');
    const rawId = hasId ? rec.id : null;
    const idTypeOk = rawId === null || typeof rawId === 'string' || typeof rawId === 'number';
    // AUD-198-06 (audit round 1): reject a non-'2.0' `jsonrpc` field and a
    // non-(string|number|null) `id` with -32600. Pre-`initialize`
    // leniency — answering requests before the client has sent
    // `initialize` — is intentionally KEPT (see C - MCP Mode.md §
    // lifecycle); this check is orthogonal to lifecycle ordering.
    if (rec.jsonrpc !== '2.0' || !idTypeOk) {
      writeMessage({
        jsonrpc: '2.0',
        id: idTypeOk ? (rawId as JsonRpcId) : null,
        error: {
          code: -32600,
          message:
            rec.jsonrpc !== '2.0'
              ? "Invalid Request: jsonrpc must be '2.0'"
              : 'Invalid Request: id must be a string, number, or null',
        },
      });
      return;
    }
    const id = rawId as JsonRpcId;
    const method = rec.method as string;
    const params = rec.params as any;

    switch (method) {
      case 'initialize':
        respond(hasId, id, buildInitializeResult(params));
        return;
      case 'notifications/initialized':
        return; // notification — nothing to do, nothing to answer
      case 'ping':
        respond(hasId, id, {});
        return;
      case 'tools/list':
        respond(hasId, id, { tools: listTools(toolTable) });
        return;
      case 'tools/call': {
        if (!socketTarget) {
          respondError(hasId, id, -32603, 'cambium mcp: internal error — not booted');
          return;
        }
        try {
          const outcome = await handleToolsCall(socketTarget, toolTable, params);
          if (outcome.kind === 'error') respondError(hasId, id, outcome.code, outcome.message);
          else respond(hasId, id, outcome.result);
        } catch (err) {
          respondError(hasId, id, -32603, errorMessage(err));
        }
        return;
      }
      default:
        respondError(hasId, id, -32601, `Method not found: ${method}`);
        return;
    }
  }

  return { ready, closed, close };
}

// ── initialize (DEC-005) ────────────────────────────────────────────────

function buildInitializeResult(params: any): Record<string, unknown> {
  const requested = params?.protocolVersion;
  const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'cambium', version: RUNNER_VERSION },
  };
}

// ── private socket (DEC-002) ────────────────────────────────────────────

interface PrivateBind {
  bind: BindTarget;
  socketDir: string | null;
  /** `node:http`'s `socketPath` value for this bind — the unix path, or
   *  the win32 pipe path. Computed alongside `bind` so callers never
   *  have to narrow the `BindTarget` union back down themselves. */
  socketTarget: string;
}

/** Capacity of `sockaddr_un.sun_path`, in bytes, for this platform. The path
 *  must fit inside it *with* its NUL terminator, so the usable maximum is one
 *  less. Linux sizes the field at 108; macOS and the BSDs at 104. */
const SUN_PATH_BYTES = process.platform === 'linux' ? 108 : 104;

function makePrivateBind(): PrivateBind {
  if (process.platform === 'win32') {
    const name = `cambium-mcp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const pipePath = `\\\\.\\pipe\\${name}`;
    return { bind: { kind: 'pipe', name, pipePath }, socketDir: null, socketTarget: pipePath };
  }
  const dir = mkdtempSync(join(tmpdir(), 'cambium-mcp-'));
  const path = join(dir, 'mcp.sock');
  // The socket path is built under TMPDIR, so a long TMPDIR can push it past
  // `sun_path`. Check before binding rather than after: the two ways the
  // kernel and Node handle an overlong path are both worse than a refusal.
  // Node >=23 fails the `listen` with a bare `EINVAL` naming no cause; Node
  // <23 silently TRUNCATES, so `listen` succeeds at a path that is not the
  // one we hand the HTTP client, and every `tools/call` then fails to reach
  // a server that is demonstrably running. Refusing here is deterministic on
  // every Node version and platform, and says what to do about it.
  const bytes = Buffer.byteLength(path);
  if (bytes > SUN_PATH_BYTES - 1) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `private socket path is ${bytes} bytes, over this platform's ` +
        `${SUN_PATH_BYTES - 1}-byte limit for a unix socket: ${path}\n` +
        `The path is built under TMPDIR — set TMPDIR to a shorter directory and retry.`,
    );
  }
  return { bind: { kind: 'unix', path }, socketDir: dir, socketTarget: path };
}

// ── HTTP client over the private socket ─────────────────────────────────

/** `node:http.request({ socketPath })` works against both a unix socket
 *  path and a win32 named-pipe path (A-4; win32 untested — CI is linux). */
function httpRequestJson<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolveP(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (e: any) {
            rejectP(new Error(`cambium mcp: malformed JSON from ${path}: ${e?.message ?? String(e)}`));
          }
        });
      },
    );
    req.on('error', rejectP);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── tools/list derivation (DEC-006 / DEC-007) ───────────────────────────

/** `<placeholder>` → `placeholder`, else `null`. Every string example
 *  `catalogExampleInvocation` (serve.ts, #197) produces for a gen or a
 *  1-slot pipeline has this shape. */
function extractPlaceholder(s: string): string | null {
  const m = /^<(.+)>$/.exec(s);
  return m ? m[1] : null;
}

/** DEC-007: one input shape per catalog *entry* (not per method) —
 *  derived from the entry's `kind` + its single `example.input`. */
export function deriveInputShape(entry: GenCatalogWireEntry): InputShape {
  const example = entry.example.input;
  if (entry.kind === 'gen') {
    const key = typeof example === 'string' ? extractPlaceholder(example) ?? 'input' : 'input';
    return { mode: 'string', noun: `the gen's ${key} context` };
  }
  // pipeline
  if (example === '') return { mode: 'optionalString' };
  if (typeof example === 'string') {
    const slot = extractPlaceholder(example) ?? 'input';
    return { mode: 'string', noun: `the pipeline's ${slot} input` };
  }
  if (example && typeof example === 'object' && !Array.isArray(example)) {
    return { mode: 'object', slots: Object.keys(example as Record<string, unknown>) };
  }
  // Defensive fallback — catalogExampleInvocation never produces anything
  // else, but an unrecognized shape degrades to "accept anything" rather
  // than throw at boot.
  return { mode: 'optionalString' };
}

export function buildInputSchema(shape: InputShape): Record<string, unknown> {
  if (shape.mode === 'string') {
    return {
      type: 'object',
      properties: { input: { type: 'string', description: `Content for ${shape.noun}` } },
      required: ['input'],
    };
  }
  if (shape.mode === 'optionalString') {
    return {
      type: 'object',
      properties: { input: { type: 'string', description: 'Optional — this pipeline declares no input slots' } },
      required: [],
    };
  }
  const properties: Record<string, unknown> = {};
  for (const slot of shape.slots) properties[slot] = { type: 'string' };
  return {
    type: 'object',
    properties: {
      // additionalProperties: false — matches validateToolInput's exact-keys
      // enforcement below (AUD-198-F1); the outer `arguments` object stays
      // lenient in both the schema and the validator, deliberately.
      input: { type: 'object', properties, required: [...shape.slots], additionalProperties: false },
    },
    required: ['input'],
  };
}

export function deriveDescription(entry: GenCatalogWireEntry, method: string): string {
  const base = entry.description ?? `Run ${entry.name}.${method}`;
  return entry.methods.length > 1 ? `${base} (method: ${method})` : base;
}

/** DEC-006: `<GenName>__<method>`, reverse-mapped by table, never parsed
 *  back. A collision fails boot (both sources named); a name over 64
 *  chars gets a stderr warning but is still served. */
export function buildToolTable(entries: GenCatalogWireEntry[]): Map<string, ToolTableEntry> {
  const table = new Map<string, ToolTableEntry>();
  for (const entry of entries) {
    const shape = deriveInputShape(entry);
    const inputSchema = buildInputSchema(shape);
    for (const method of entry.methods) {
      const toolName = `${entry.name}__${method}`;
      const prior = table.get(toolName);
      if (prior) {
        throw new Error(
          `cambium mcp: tool name collision '${toolName}' — both ${prior.gen}.${prior.method} and ` +
            `${entry.name}.${method} map to it under the <GenName>__<method> naming scheme.`,
        );
      }
      if (toolName.length > 64) {
        process.stderr.write(
          `[cambium mcp] warning: tool name '${toolName}' is ${toolName.length} chars — ` +
            `some MCP hosts cap tool names at 64.\n`,
        );
      }
      const returnsSchema = entry.returns?.[method];
      table.set(toolName, {
        gen: entry.name,
        method,
        shape,
        inputSchema,
        description: deriveDescription(entry, method),
        outputSchema: returnsSchema ?? undefined,
      });
    }
  }
  return table;
}

export function listTools(table: Map<string, ToolTableEntry>): unknown[] {
  const tools: unknown[] = [];
  for (const [name, entry] of table) {
    const tool: Record<string, unknown> = {
      name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    };
    if (entry.outputSchema !== undefined) tool.outputSchema = entry.outputSchema;
    tools.push(tool);
  }
  return tools;
}

// ── tools/call dispatch + mapping (DEC-008) ─────────────────────────────

type ToolsCallOutcome = { kind: 'error'; code: number; message: string } | { kind: 'result'; result: unknown };

type ValidatedInput = { ok: true; value: unknown } | { ok: false; message: string };

/** DEC-011 (audit round 1, closes AUD-198-01): validate `arguments`
 *  structurally against the SAME closed shape DEC-007 derived the tool's
 *  advertised `inputSchema` from, BEFORE dispatch — a call that fails
 *  its own advertised schema never reaches `/v1/run`. No AJV, no new
 *  dep: the shape set is closed (`InputShape`), so a hand-rolled check
 *  is exact. */
export function validateToolInput(entry: ToolTableEntry, args: Record<string, unknown>): ValidatedInput {
  const toolName = `${entry.gen}__${entry.method}`;
  const shape = entry.shape;

  if (shape.mode === 'optionalString') {
    if (!Object.prototype.hasOwnProperty.call(args, 'input')) return { ok: true, value: '' };
    if (typeof args.input !== 'string') {
      return { ok: false, message: `${toolName}: field 'input' must be a string when present` };
    }
    return { ok: true, value: args.input };
  }

  if (shape.mode === 'string') {
    if (typeof args.input !== 'string') {
      return { ok: false, message: `${toolName}: field 'input' is required and must be a string` };
    }
    return { ok: true, value: args.input };
  }

  // shape.mode === 'object' (N-slot pipeline): `input` must be an object
  // whose keys are EXACTLY the declared slots, each a string.
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      message: `${toolName}: field 'input' must be an object with keys: ${shape.slots.join(', ')}`,
    };
  }
  const inputObj = input as Record<string, unknown>;
  const declared = new Set(shape.slots);
  const missing = shape.slots.filter((s) => !Object.prototype.hasOwnProperty.call(inputObj, s));
  if (missing.length > 0) {
    return { ok: false, message: `${toolName}: field 'input.${missing[0]}' is required` };
  }
  const extra = Object.keys(inputObj).filter((k) => !declared.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      message: `${toolName}: field 'input.${extra[0]}' is not a declared slot (expected: ${shape.slots.join(', ')})`,
    };
  }
  for (const slot of shape.slots) {
    if (typeof inputObj[slot] !== 'string') {
      return { ok: false, message: `${toolName}: field 'input.${slot}' must be a string` };
    }
  }
  return { ok: true, value: inputObj };
}

async function handleToolsCall(
  socketTarget: string,
  table: Map<string, ToolTableEntry>,
  params: any,
): Promise<ToolsCallOutcome> {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    return { kind: 'error', code: -32602, message: 'params.name must be a string' };
  }
  const entry = table.get(params.name);
  if (!entry) {
    return { kind: 'error', code: -32602, message: `unknown tool '${params.name}' — not present in tools/list` };
  }

  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const validated = validateToolInput(entry, args);
  if (!validated.ok) {
    return { kind: 'error', code: -32602, message: validated.message };
  }
  const toolInput = validated.value;

  const runResp = await httpRequestJson<any>(socketTarget, 'POST', '/v1/run', {
    gen: entry.gen,
    method: entry.method,
    input: toolInput,
  });

  if (runResp?.ok) {
    return {
      kind: 'result',
      result: {
        content: [{ type: 'text', text: JSON.stringify(runResp.output) }],
        structuredContent: runResp.output,
      },
    };
  }

  // DEC-008: dispatch failures relay the `/v1/run` error envelope
  // verbatim — never retried, transformed, or re-classified — in BOTH
  // the text content (for models that only read text) and
  // structuredContent (for callers that branch on `error.kind`).
  return {
    kind: 'result',
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: runResp?.error, run_id: runResp?.run_id ?? null }) }],
      structuredContent: { error: runResp?.error, run_id: runResp?.run_id ?? null },
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
