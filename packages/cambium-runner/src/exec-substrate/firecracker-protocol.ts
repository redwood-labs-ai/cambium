/**
 * Host-side wire-protocol helpers for the Firecracker substrate (RED-251).
 *
 * Mirrors what `firecracker-testbed/fc_vsock_probe.py` does, in TypeScript:
 *
 *   1. Dial Firecracker's parent vsock UDS.
 *   2. Negotiate `CONNECT <port>\n` → expect `OK <backend_port>\n`.
 *      Retry the full cycle on failure — the UDS exists as soon as
 *      `PUT /vsock` lands but the guest-side listener doesn't come up
 *      until the kernel boots + rootfs mounts + agent binds.
 *   3. Exchange length-prefixed JSON frames with the in-guest agent.
 *      Matches `crates/cambium-agent/src/frame.rs` — 4-byte big-endian
 *      u32 header, then the JSON body.
 *
 * Lives separately from `firecracker.ts` so the protocol is unit-testable
 * without spinning up a real VM. The substrate layers the lifecycle
 * (firecracker binary, API calls, cleanup) on top of these primitives.
 */

import { Socket } from 'node:net';

/** Agent's listen port. Must match `crates/cambium-agent/src/lib.rs`. */
export const VSOCK_GUEST_PORT = 52717;

/** Ceiling from `crates/cambium-agent/src/frame.rs`. Host + guest must agree. */
export const MAX_FRAME_BYTES = 100 * 1024 * 1024;

/** Cap on the CONNECT response line so a runaway Firecracker can't make
 *  us buffer forever. The real response is ~20 bytes. */
const MAX_CONNECT_LINE_BYTES = 128;

/**
 * Minimal stream buffer on top of `node:net` Socket. Needed because the
 * wire protocol is two-phase (ASCII line for the handshake, then binary
 * frames), and Node's streaming API doesn't compose cleanly across
 * that boundary without explicit buffering.
 *
 * Not a general-purpose buffered socket — only the two read modes the
 * substrate actually uses: `readLine` (ASCII, newline-terminated, for
 * the CONNECT handshake) and `readExactly` (byte count, for the frame
 * header + body). Each read applies its own timeout and rejects cleanly
 * on peer close.
 */
class BufferedSocket {
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private err: Error | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly sock: Socket) {
    sock.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.notify();
    });
    sock.on('end', () => {
      this.closed = true;
      this.notify();
    });
    sock.on('close', () => {
      this.closed = true;
      this.notify();
    });
    sock.on('error', (e: Error) => {
      this.err = e;
      this.closed = true;
      this.notify();
    });
  }

  write(data: string | Buffer): void {
    this.sock.write(data);
  }

  destroy(): void {
    this.sock.destroy();
  }

  async readExactly(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.err) throw this.err;
      if (this.closed) {
        throw new Error(
          `peer closed after ${this.buf.length} bytes, expected ${n}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`readExactly timeout after ${timeoutMs}ms`);
      }
      await this.waitForData(remaining);
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readLine(maxBytes: number, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const nl = this.buf.indexOf(0x0a);
      if (nl !== -1) {
        const line = this.buf.subarray(0, nl).toString('ascii');
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.buf.length > maxBytes) {
        throw new Error(
          `line exceeded ${maxBytes} bytes without newline`,
        );
      }
      if (this.err) throw this.err;
      if (this.closed) {
        throw new Error('peer closed before newline');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`readLine timeout after ${timeoutMs}ms`);
      }
      await this.waitForData(remaining);
    }
  }

  private waitForData(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.waiters.indexOf(done);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.push(done);
    });
  }

  private notify(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/** Exported for tests — lets us drive the helpers against a paired
 *  in-memory Socket without going through a UDS. */
export function wrapSocket(sock: Socket): BufferedSocketLike {
  return new BufferedSocket(sock);
}

/** The subset of BufferedSocket the helpers need. Lets tests pass a
 *  fake implementation without depending on real sockets. */
export interface BufferedSocketLike {
  write(data: string | Buffer): void;
  readExactly(n: number, timeoutMs: number): Promise<Buffer>;
  readLine(maxBytes: number, timeoutMs: number): Promise<string>;
  destroy(): void;
}

/**
 * Write one JSON frame: 4-byte big-endian u32 length header + body.
 * Matches `write_frame` in `crates/cambium-agent/src/frame.rs`.
 */
export function writeFrame(sock: BufferedSocketLike, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(
      `frame too large: ${body.length} > ${MAX_FRAME_BYTES}`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  sock.write(header);
  sock.write(body);
}

/**
 * Read one JSON frame. Mirrors `read_frame` in `frame.rs`. Parses the
 * body as UTF-8 JSON; caller narrows to the expected shape.
 */
export async function readFrame(
  sock: BufferedSocketLike,
  timeoutMs: number,
): Promise<unknown> {
  const header = await sock.readExactly(4, timeoutMs);
  const length = header.readUInt32BE(0);
  if (length === 0) {
    throw new Error('agent sent empty frame');
  }
  if (length > MAX_FRAME_BYTES) {
    throw new Error(
      `agent sent oversized frame: ${length} > ${MAX_FRAME_BYTES}`,
    );
  }
  const body = await sock.readExactly(length, timeoutMs);
  return JSON.parse(body.toString('utf8'));
}

/**
 * Negotiate the host-initiated vsock handshake. Write `CONNECT <port>\n`,
 * read one ASCII line, parse an `OK <backend_port>\n` reply. Anything
 * else — `FAIL`, a short line, peer close, bytes before newline — is
 * a protocol error and throws.
 */
export async function negotiateConnect(
  sock: BufferedSocketLike,
  port: number,
  timeoutMs: number,
): Promise<string> {
  sock.write(`CONNECT ${port}\n`);
  const reply = await sock.readLine(MAX_CONNECT_LINE_BYTES, timeoutMs);
  if (!reply.startsWith('OK ')) {
    throw new Error(`vsock CONNECT rejected: ${JSON.stringify(reply)}`);
  }
  return reply;
}

/** Sleep helper used by the retry loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry the full `open UDS + CONNECT` cycle until it succeeds or the
 * deadline passes. Retrying just the UDS open isn't enough: the UDS
 * exists as soon as `PUT /vsock` lands (before boot), but the guest
 * listener takes several seconds to come up. During that window the
 * UDS accepts but Firecracker closes on CONNECT — we have to reopen
 * and retry the whole handshake. Same shape as `fc_vsock_probe.py`.
 */
export interface DialResult {
  sock: BufferedSocketLike;
  reply: string;
}

export async function dialAndHandshake(
  udsPath: string,
  port: number,
  deadlineMs: number,
  options: {
    /** Per-attempt connect timeout. */
    attemptTimeoutMs?: number;
    /** Sleep between retries. */
    retryIntervalMs?: number;
    /** Injection point for tests — replaces `net.Socket` connect. */
    _connect?: (udsPath: string) => Promise<Socket>;
    /** Injection point for tests — wraps the connected Socket. */
    _wrap?: (sock: Socket) => BufferedSocketLike;
  } = {},
): Promise<DialResult> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;
  const retryIntervalMs = options.retryIntervalMs ?? 500;
  const connect = options._connect ?? defaultConnect;
  const wrap = options._wrap ?? wrapSocket;

  let lastErr: unknown;
  while (Date.now() < deadlineMs) {
    let sock: Socket | null = null;
    let buffered: BufferedSocketLike | null = null;
    try {
      sock = await connect(udsPath);
      buffered = wrap(sock);
      const reply = await negotiateConnect(
        buffered,
        port,
        Math.min(attemptTimeoutMs, Math.max(100, deadlineMs - Date.now())),
      );
      return { sock: buffered, reply };
    } catch (e) {
      lastErr = e;
      try { buffered?.destroy(); } catch {}
      try { sock?.destroy(); } catch {}
      await sleep(retryIntervalMs);
    }
  }
  throw new Error(
    `could not establish vsock session to ${udsPath} port ${port}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function defaultConnect(udsPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const onError = (e: Error) => {
      sock.removeAllListeners();
      sock.destroy();
      reject(e);
    };
    sock.once('error', onError);
    sock.connect(udsPath, () => {
      sock.removeListener('error', onError);
      resolve(sock);
    });
  });
}
