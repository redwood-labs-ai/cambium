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
 *  appears (via `waitForApiSocket`) before making any API calls. */
export function spawnFirecracker(apiSock: string, log: LogAccumulator): ChildProcess {
  const fc = spawn(FC_BINARY, ['--api-sock', apiSock], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fc.stdout?.on('data', log.append);
  fc.stderr?.on('data', log.append);
  return fc;
}

/** Kill the firecracker child and drain the exit so no zombies
 *  accumulate. Idempotent — safe to call on already-exited children. */
export function killFirecracker(fc: ChildProcess | null): void {
  if (!fc) return;
  if (fc.exitCode === null) {
    try { fc.kill('SIGKILL'); } catch { /* already dead */ }
  }
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
