/**
 * Shared low-level Firecracker API + process helpers (RED-251 / RED-256).
 *
 * Lives separately from `firecracker.ts` and `firecracker-snapshot.ts` so
 * both paths (cold-boot + warm-restore) can share the same primitives
 * without importing from each other. Pure transport + process layer;
 * no business logic about what SEQUENCE of calls to make — that's the
 * caller's concern.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';

export const FC_BINARY = 'firecracker';

/** Bound on the firecracker child's log accumulator. A misbehaving or
 *  compromised firecracker binary emitting gigabytes of log output
 *  would otherwise OOM the Node process. 1 MB is far above the ~60 kB
 *  a real Firecracker emits on a full boot. Once hit, later chunks
 *  are dropped silently; error paths tail the last 30 lines. */
export const FC_LOG_MAX_BYTES = 1_000_000;

export interface LogAccumulator {
  append: (chunk: Buffer) => void;
  tail: (lines: number) => string;
}

/** A bounded buffer for the firecracker child's stdout/stderr.
 *  Returns a closure + tail helper. Shared between the cold-boot and
 *  warm-restore paths. */
export function makeLogAccumulator(): LogAccumulator {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    append(chunk: Buffer) {
      if (bytes >= FC_LOG_MAX_BYTES) return;
      bytes += chunk.length;
      chunks.push(chunk);
    },
    tail(lines: number) {
      if (chunks.length === 0) return '';
      return Buffer.concat(chunks).toString('utf8').split('\n').slice(-lines).join('\n');
    },
  };
}

/** Spawn a firecracker child process attached to the given API
 *  socket. The caller is responsible for waiting until the socket
 *  appears (via `waitForApiSocket`) before making any API calls.
 *
 *  When `netns` is provided, runs firecracker inside that network
 *  namespace via `ip netns exec <name> firecracker ...` — this is
 *  the RED-259 network-allowlist path, where the tap device the
 *  guest's virtio-net binds to lives inside the netns. FC opens its
 *  tap fd from whatever netns its process lives in, so dispatching
 *  via `ip netns exec` is the mechanism.
 *
 *  The netns path needs CAP_NET_ADMIN to invoke `ip netns exec`.
 *  Default is to prefix with `sudo -n`; `nsPrivileged: false` skips
 *  the prefix for environments that are already root or that grant
 *  the capability via setcap.
 */
export function spawnFirecracker(
  apiSock: string,
  log: LogAccumulator,
  opts: { netns?: string; nsPrivileged?: boolean } = {},
): ChildProcess {
  let binary: string;
  let argv: string[];
  if (opts.netns) {
    // Mirror firecracker-netns.ts::runPrivileged so the NOSUDO escape
    // hatch works consistently: operators who set up CAP_NET_ADMIN
    // via setcap instead of sudo can set CAMBIUM_FC_NETNS_NOSUDO=1
    // and BOTH the setup commands AND the FC spawn skip the sudo
    // prefix. Prior to this, the escape hatch was half-wired — netns
    // setup worked without sudo but the FC spawn still prepended
    // `sudo -n`, causing the dispatch to fail.
    const needsSudo =
      opts.nsPrivileged ??
      (process.getuid?.() !== 0 && process.env.CAMBIUM_FC_NETNS_NOSUDO !== '1');
    const full = needsSudo
      ? ['sudo', '-n', 'ip', 'netns', 'exec', opts.netns, FC_BINARY, '--api-sock', apiSock]
      : ['ip', 'netns', 'exec', opts.netns, FC_BINARY, '--api-sock', apiSock];
    binary = full[0]!;
    argv = full.slice(1);
  } else {
    binary = FC_BINARY;
    argv = ['--api-sock', apiSock];
  }
  const fc = spawn(binary, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fc.stdout?.on('data', log.append);
  fc.stderr?.on('data', log.append);
  return fc;
}

/** Kill the firecracker child. Idempotent — safe to call on
 *  already-exited children. Does NOT wait for exit; use
 *  `drainFirecracker` when the caller needs to be sure FC has
 *  released its resources (tap fds, netns refs) before tearing them
 *  down. Kept sync so the common-case cleanup path stays simple. */
export function killFirecracker(fc: ChildProcess | null): void {
  if (!fc) return;
  if (fc.exitCode === null) {
    try { fc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

/** Wait for FC to actually exit after a `killFirecracker` — SIGKILL
 *  is immediate at the kernel level, but Node doesn't observe the
 *  exit until the next event-loop turn (and FC's own cleanup can
 *  hold file descriptors briefly). Tearing down the netns + tap
 *  device while FC still holds the tap fd leaks kernel state (the
 *  tap persists under the fd, and `ip netns delete` silently fails
 *  or leaves a zombie netns). This helper awaits `exit` with a short
 *  deadline so the cleanup-then-teardown ordering is correct.
 *
 *  Returns when FC is known dead OR the deadline elapses. A timeout
 *  is not an error — the caller treats it as "best-effort; FC is
 *  probably reaped by now, teardown proceeds either way." */
export function drainFirecracker(
  fc: ChildProcess | null,
  timeoutMs = 1_000,
): Promise<void> {
  if (!fc) return Promise.resolve();
  if (fc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    fc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Wait up to `timeoutMs` for a UNIX socket to appear at `path`. */
export async function waitForApiSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Firecracker API socket did not appear at ${path} within ${timeoutMs}ms`);
}

async function apiCall(
  method: 'PUT' | 'PATCH' | 'GET',
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8');
    }
    const req = request(
      { socketPath, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** PUT `body` to the API. Throws unless the response is 204. */
export async function apiPutExpect204(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<void> {
  const { statusCode, body: respBody } = await apiCall('PUT', socketPath, path, body);
  if (statusCode !== 204) {
    throw new Error(`Firecracker API PUT ${path} returned ${statusCode}: ${respBody}`);
  }
}

/** PATCH `body` to the API. Throws unless the response is 204. */
export async function apiPatchExpect204(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<void> {
  const { statusCode, body: respBody } = await apiCall('PATCH', socketPath, path, body);
  if (statusCode !== 204) {
    throw new Error(`Firecracker API PATCH ${path} returned ${statusCode}: ${respBody}`);
  }
}

/** PUT that resolves with the full response rather than throwing. Used
 *  by the snapshot path where a non-204 is a classifiable failure
 *  (fall back to cold-boot) rather than a hard error. */
export async function apiPutRaw(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  return apiCall('PUT', socketPath, path, body);
}
