import { describe, it, expect } from 'vitest';
import { Duplex } from 'node:stream';
import {
  writeFrame,
  readFrame,
  negotiateConnect,
  dialAndHandshake,
  wrapSocket,
  type BufferedSocketLike,
  VSOCK_GUEST_PORT,
} from './firecracker-protocol.js';

/**
 * Minimal fake buffered socket driven by a queued script. Lets us
 * exercise frame + handshake helpers without a real socket pair. Each
 * push* call queues a `resolve(...)` that the helper's next async read
 * resolves against.
 */
class FakeBufferedSocket implements BufferedSocketLike {
  public written: Buffer[] = [];
  private readPlan: Array<(requested?: number) => Promise<Buffer | string>> = [];
  private destroyed = false;

  write(data: string | Buffer): void {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  destroy(): void {
    this.destroyed = true;
  }

  async readExactly(n: number, _timeoutMs: number): Promise<Buffer> {
    const next = this.readPlan.shift();
    if (!next) throw new Error('readExactly: no more planned responses');
    const result = await next(n);
    if (typeof result === 'string') {
      throw new Error('readExactly: planned response was a string');
    }
    if (result.length !== n) {
      throw new Error(
        `readExactly: planned response length ${result.length} != requested ${n}`,
      );
    }
    return result;
  }

  async readLine(_maxBytes: number, _timeoutMs: number): Promise<string> {
    const next = this.readPlan.shift();
    if (!next) throw new Error('readLine: no more planned responses');
    const result = await next();
    if (typeof result !== 'string') {
      throw new Error('readLine: planned response was not a string');
    }
    return result;
  }

  planExactly(response: Buffer): void {
    this.readPlan.push(async (n) => {
      if (n !== response.length) {
        throw new Error(
          `planExactly: expected request for ${response.length}, got ${n}`,
        );
      }
      return response;
    });
  }

  planLine(line: string): void {
    this.readPlan.push(async () => line);
  }

  planError(err: Error, forExactly = false): void {
    this.readPlan.push(async (_n) => {
      // Keep the signature varied so the helper doesn't trip on it.
      void forExactly;
      throw err;
    });
  }

  get wasDestroyed(): boolean {
    return this.destroyed;
  }

  get writtenString(): string {
    return Buffer.concat(this.written).toString('utf8');
  }
}

describe('writeFrame / readFrame round-trip', () => {
  it('encodes and decodes a JSON value with a 4-byte big-endian header', async () => {
    const fake = new FakeBufferedSocket();
    writeFrame(fake, { hello: 'world', n: 42 });

    // Combined header + body should be reconstructable.
    const combined = Buffer.concat(fake.written);
    expect(combined.readUInt32BE(0)).toBe(combined.length - 4);

    // Feed the combined bytes back through readFrame.
    fake.planExactly(combined.subarray(0, 4));
    fake.planExactly(combined.subarray(4));
    const decoded = await readFrame(fake, 1_000);
    expect(decoded).toEqual({ hello: 'world', n: 42 });
  });

  it('rejects frames larger than MAX_FRAME_BYTES from the wire', async () => {
    const fake = new FakeBufferedSocket();
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(0x0fffffff, 0); // just over the 100MB cap
    fake.planExactly(bogus);
    await expect(readFrame(fake, 1_000)).rejects.toThrow(/oversized frame/);
  });

  it('rejects zero-length frames — they indicate a broken agent', async () => {
    const fake = new FakeBufferedSocket();
    fake.planExactly(Buffer.from([0, 0, 0, 0]));
    await expect(readFrame(fake, 1_000)).rejects.toThrow(/empty frame/);
  });
});

describe('negotiateConnect', () => {
  it('writes CONNECT <port>\\n and resolves on an OK line', async () => {
    const fake = new FakeBufferedSocket();
    fake.planLine('OK 1073741825');
    const reply = await negotiateConnect(fake, VSOCK_GUEST_PORT, 1_000);
    expect(reply).toBe('OK 1073741825');
    expect(fake.writtenString).toBe('CONNECT 52717\n');
  });

  it('rejects non-OK replies cleanly', async () => {
    const fake = new FakeBufferedSocket();
    fake.planLine('FAIL 1');
    await expect(negotiateConnect(fake, VSOCK_GUEST_PORT, 1_000)).rejects.toThrow(
      /vsock CONNECT rejected/,
    );
  });
});

describe('dialAndHandshake retry logic', () => {
  it('retries connect failures until the deadline, then surfaces the last error', async () => {
    let attempts = 0;
    const deadline = Date.now() + 200; // short
    const connectErr = new Error('ECONNREFUSED');
    const result = dialAndHandshake('/nowhere', VSOCK_GUEST_PORT, deadline, {
      retryIntervalMs: 20,
      _connect: async () => {
        attempts += 1;
        throw connectErr;
      },
    });
    await expect(result).rejects.toThrow(/could not establish vsock session/);
    expect(attempts).toBeGreaterThan(1);
  });

  it('retries handshake failures — e.g. peer closes after CONNECT — until one succeeds', async () => {
    let attempt = 0;
    const deadline = Date.now() + 500;
    // Succeed on the third attempt. Earlier attempts simulate the
    // "guest hasn't bound yet" window: UDS accepts, but CONNECT is
    // rejected with EOF on the response read.
    const connect = async () => {
      return {} as any; // we'll swap in a fake via _wrap
    };
    const wrap = (_sock: any): BufferedSocketLike => {
      attempt += 1;
      const fake = new FakeBufferedSocket();
      if (attempt < 3) {
        fake.planError(new Error('peer closed before newline'));
      } else {
        fake.planLine('OK 42');
      }
      return fake;
    };
    const result = await dialAndHandshake('/tmp/x.sock', VSOCK_GUEST_PORT, deadline, {
      retryIntervalMs: 20,
      _connect: connect,
      _wrap: wrap,
    });
    expect(result.reply).toBe('OK 42');
    expect(attempt).toBe(3);
  });
});

describe('BufferedSocket (real Duplex pair)', () => {
  // Integration-ish test: create two Duplex streams piped together so
  // `wrapSocket` + the helpers exercise the real data/end/error event
  // plumbing, not just the FakeBufferedSocket surface.
  it('round-trips a frame through wrapSocket', async () => {
    const clientSide = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        serverSide.push(chunk);
        cb();
      },
      final(cb) {
        serverSide.push(null);
        cb();
      },
    });
    const serverSide = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        clientSide.push(chunk);
        cb();
      },
      final(cb) {
        clientSide.push(null);
        cb();
      },
    });

    const clientBuf = wrapSocket(clientSide as unknown as any);
    const serverBuf = wrapSocket(serverSide as unknown as any);

    writeFrame(clientBuf, { ping: true });
    const decoded = await readFrame(serverBuf, 1_000);
    expect(decoded).toEqual({ ping: true });
  });
});
