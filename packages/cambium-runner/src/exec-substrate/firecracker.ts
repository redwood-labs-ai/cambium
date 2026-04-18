/**
 * `:firecracker` substrate — microVM isolation (RED-251).
 *
 * Ports the tested host-side sequence from `firecracker-testbed/smoke.sh`
 * + `fc_vsock_probe.py` into the runner. One microVM per call (per-call
 * cold-start for v1; snapshot/restore is RED-256).
 *
 * Flow per `execute()`:
 *
 *   1. Spawn `firecracker --api-sock /tmp/fc-<id>.sock`.
 *   2. Drive the API in sequence:
 *        PUT /machine-config    (vcpu + RAM from ExecOpts)
 *        PUT /boot-source       (vmlinux + cmdline, `init=cambium-agent`)
 *        PUT /drives/rootfs     (RED-255 rootfs, path from env)
 *        PUT /vsock             (parent UDS path + guest CID 3)
 *        PUT /actions           (InstanceStart)
 *   3. Dial the vsock parent UDS, negotiate `CONNECT 52717\n`.
 *   4. Frame-write one ExecRequest (matches the agent's
 *      `crates/cambium-agent/src/protocol.rs`).
 *   5. Frame-read one ExecResponse.
 *   6. Kill the firecracker process + clean up sockets + temp rootfs.
 *
 * Kernel + rootfs paths are operator-level config (not per-gen), read
 * from env:
 *
 *   CAMBIUM_FC_KERNEL  — path to vmlinux
 *   CAMBIUM_FC_ROOTFS  — path to rootfs.ext4 (the RED-255 image)
 *
 * `available()` returns null only when Linux + KVM + firecracker binary
 * + both env vars are all present.
 *
 * v1 scope (deliberately narrow, matching what the testbed proves):
 *
 *   - `network: 'none'` only. An allowlist errors with a pointer to
 *     the follow-up ticket. Same for a non-'none' filesystem.
 *   - No snapshot/restore. Every call is cold-boot.
 *   - No bind-mount drives. The agent only sees the rootfs.
 *
 * Those v1.x extensions are separate tickets — the scope of this file
 * is "make the testbed's green round-trip runnable from TS."
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { delimiter } from 'node:path';
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';
import type { NetworkPolicy } from '../tools/permissions.js';
import {
  VSOCK_GUEST_PORT,
  dialAndHandshake,
  writeFrame,
  readFrame,
  type BufferedSocketLike,
} from './firecracker-protocol.js';

const FC_BINARY = 'firecracker';
const GUEST_CID = 3;
const AGENT_INIT_PATH = '/usr/local/bin/cambium-agent';
const KERNEL_ENV = 'CAMBIUM_FC_KERNEL';
const ROOTFS_ENV = 'CAMBIUM_FC_ROOTFS';

/**
 * Shape the agent returns over vsock. Matches `ExecResponse` in
 * `crates/cambium-agent/src/protocol.rs`. Narrowing lives here (rather
 * than a shared type file) because it's the Firecracker substrate's
 * private protocol contract.
 */
interface AgentResponse {
  status: 'completed' | 'timeout' | 'oom' | 'egress_denied' | 'crashed';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  duration_ms: number;
  reason: string | null;
}

const AGENT_STATUS_VALUES = [
  'completed',
  'timeout',
  'oom',
  'egress_denied',
  'crashed',
] as const;

function isAgentResponse(v: unknown): v is AgentResponse {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.status === 'string' &&
    (AGENT_STATUS_VALUES as readonly string[]).includes(obj.status) &&
    typeof obj.stdout === 'string' &&
    typeof obj.stderr === 'string'
  );
}

function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  const slice = s.slice(0, maxBytes);
  return { text: `${slice}\n[truncated at ${maxBytes} bytes]`, truncated: true };
}

/**
 * Whether `firecracker` is on PATH. Does a lexical search rather than
 * spawning, so `available()` stays synchronous and side-effect-free.
 */
function firecrackerOnPath(): boolean {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, FC_BINARY);
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

function checkAvailable(): string | null {
  if (process.platform !== 'linux') {
    return `:firecracker requires Linux + KVM (detected ${process.platform}); use runtime: :wasm.`;
  }
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch {
    return '/dev/kvm is not accessible. Firecracker requires KVM; check that the host has KVM enabled and the runner user can read+write /dev/kvm.';
  }
  if (!firecrackerOnPath()) {
    return `firecracker binary not found on PATH (${process.env.PATH ?? ''}). Install from https://github.com/firecracker-microvm/firecracker/releases.`;
  }
  const kernel = process.env[KERNEL_ENV];
  const rootfs = process.env[ROOTFS_ENV];
  if (!kernel || !existsSync(kernel)) {
    return `${KERNEL_ENV}=${kernel ?? ''} does not point to an existing vmlinux file. Set ${KERNEL_ENV} to a Firecracker-compatible kernel image (see firecracker-testbed/kernel/).`;
  }
  if (!rootfs || !existsSync(rootfs)) {
    return `${ROOTFS_ENV}=${rootfs ?? ''} does not point to an existing rootfs.ext4 file. Set ${ROOTFS_ENV} to the RED-255 rootfs image (see firecracker-testbed/rootfs/).`;
  }
  return null;
}

export class FirecrackerSubstrate implements ExecSubstrate {
  private _cachedAvailable: string | null | undefined;

  available(): string | null {
    if (this._cachedAvailable !== undefined) return this._cachedAvailable;
    this._cachedAvailable = checkAvailable();
    return this._cachedAvailable;
  }

  async execute(opts: ExecOpts): Promise<ExecResult> {
    const startedAt = Date.now();

    // Policy scope checks — v1 is vsock-only, rootfs-only.
    const scopeError = checkScope(opts);
    if (scopeError) {
      return {
        status: 'crashed',
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        reason: scopeError,
      };
    }

    const reason = this.available();
    if (reason !== null) {
      return {
        status: 'crashed',
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        reason,
      };
    }

    const workDir = mkdtempSync(join(tmpdir(), 'cambium-fc-'));
    const runId = randomBytes(4).toString('hex');
    const apiSock = join(workDir, `fc-${runId}.api.sock`);
    const vsockUds = join(workDir, `fc-${runId}.vsock.sock`);
    const stagedRootfs = join(workDir, 'rootfs.ext4');

    let fc: ChildProcess | null = null;
    let vsockSock: BufferedSocketLike | null = null;
    const fcLog: Buffer[] = [];
    // Bound the firecracker-log accumulator so a misbehaving or
    // compromised firecracker binary emitting gigabytes of log output
    // can't OOM the Node process. 1 MB is far above the ~60 kB real
    // Firecracker emits even on a full boot; once hit, later chunks
    // are dropped silently (the error path already tails the last 30
    // lines, which will have the most useful tail if we ever get
    // anywhere near the cap).
    const FC_LOG_MAX_BYTES = 1_000_000;
    let fcLogBytes = 0;
    const appendLog = (c: Buffer) => {
      if (fcLogBytes >= FC_LOG_MAX_BYTES) return;
      fcLogBytes += c.length;
      fcLog.push(c);
    };

    try {
      // Re-check the rootfs file exists and is readable NOW, not at
      // `available()` time. available() caches its result at runner
      // startup; a rootfs that was present then but has since been
      // removed or made unreadable would otherwise surface as a raw
      // copyFileSync exception rather than a clean crashed result.
      const rootfsPath = process.env[ROOTFS_ENV];
      if (!rootfsPath || !existsSync(rootfsPath)) {
        return crashed(
          startedAt,
          `${ROOTFS_ENV}=${rootfsPath ?? ''} does not point to an existing rootfs.ext4 file at dispatch time (was valid at startup, changed since).`,
        );
      }
      // Stage the rootfs in the workdir so the guest can write to it
      // without dirtying the source artifact. Same reasoning as smoke.sh.
      // Inside try/finally so a copy failure still cleans up workDir.
      copyFileSync(rootfsPath, stagedRootfs);

      fc = spawn(FC_BINARY, ['--api-sock', apiSock], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fc.stdout?.on('data', appendLog);
      fc.stderr?.on('data', appendLog);

      await waitForSocket(apiSock, 5_000);
      // Wall-clock budget for everything from now until response
      // read. Gives boot + vsock-listen setup up to 20s, plus the
      // user's requested interpreter timeout.
      const bootDeadline = Date.now() + 20_000;
      const responseDeadline = Date.now() + 20_000 + opts.timeout * 1000 + 5_000;

      await apiPutExpect204(apiSock, '/machine-config', {
        vcpu_count: Math.max(1, Math.round(opts.cpu)),
        mem_size_mib: Math.max(16, Math.round(opts.memory)),
      });
      await apiPutExpect204(apiSock, '/boot-source', {
        kernel_image_path: process.env[KERNEL_ENV],
        boot_args: `console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=${AGENT_INIT_PATH}`,
      });
      await apiPutExpect204(apiSock, '/drives/rootfs', {
        drive_id: 'rootfs',
        path_on_host: stagedRootfs,
        is_root_device: true,
        is_read_only: false,
      });
      await apiPutExpect204(apiSock, '/vsock', {
        vsock_id: 'vsock0',
        guest_cid: GUEST_CID,
        uds_path: vsockUds,
      });
      await apiPutExpect204(apiSock, '/actions', {
        action_type: 'InstanceStart',
      });

      const { sock } = await dialAndHandshake(
        vsockUds,
        VSOCK_GUEST_PORT,
        bootDeadline,
      );
      vsockSock = sock;

      writeFrame(vsockSock, {
        language: opts.language,
        code: opts.code,
        cpu: opts.cpu,
        memory_mb: Math.max(16, Math.round(opts.memory)),
        timeout_seconds: Math.max(1, Math.round(opts.timeout)),
        max_output_bytes: opts.maxOutputBytes,
      });

      const readTimeoutMs = Math.max(1_000, responseDeadline - Date.now());
      const raw = await readFrame(vsockSock, readTimeoutMs);
      if (!isAgentResponse(raw)) {
        return crashed(
          startedAt,
          `agent returned unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`,
        );
      }
      return translateResponse(raw, opts, startedAt);
    } catch (e: any) {
      return crashed(
        startedAt,
        `${e?.message ?? String(e)}${
          fcLog.length
            ? `\n--- firecracker log tail ---\n${Buffer.concat(fcLog)
                .toString('utf8')
                .split('\n')
                .slice(-30)
                .join('\n')}`
            : ''
        }`,
      );
    } finally {
      try { vsockSock?.destroy(); } catch {}
      if (fc && fc.exitCode === null) {
        try { fc.kill('SIGKILL'); } catch {}
      }
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/** v1 scope gate. Returns null on allowed shapes, error message on any
 *  currently-unsupported combo. Network/filesystem allowlists are
 *  tracked as follow-ups; they fail closed here rather than silently
 *  downgrading. */
function checkScope(opts: ExecOpts): string | null {
  if (opts.network !== 'none') {
    // NetworkPolicy with an allowlist isn't wired yet — netns + iptables
    // rule generation is a separate piece. Error rather than silently
    // ignoring so a gen with real requirements isn't lulled into false
    // security.
    const np = opts.network as NetworkPolicy;
    return `:firecracker v1 supports network: 'none' only (got allowlist: ${
      np?.allowlist?.join(', ') ?? 'unknown'
    }). Host-side netns + iptables resolution is a follow-up; for network access, use runtime: :native (unsandboxed) or file a ticket.`;
  }
  if (opts.filesystem !== 'none') {
    // Optional-chain the allowlist_paths read: a malformed IR could
    // send `filesystem: {}` or another shape without the field. Keep
    // the error message clean rather than letting a TypeError leak
    // through as a raw stack trace in the reason string. The gate
    // still fails closed — anything other than the literal 'none'
    // returns this error.
    const paths = (opts.filesystem as { allowlist_paths?: string[] })
      ?.allowlist_paths?.join(', ') ?? '(no allowlist_paths)';
    return `:firecracker v1 supports filesystem: 'none' only (got allowlist_paths: ${paths}). Host-side bind-mount drive resolution is a follow-up; for filesystem access, use runtime: :native (unsandboxed) or file a ticket.`;
  }
  return null;
}

function crashed(startedAt: number, reason: string): ExecResult {
  return {
    status: 'crashed',
    stdout: '',
    stderr: '',
    truncated: { stdout: false, stderr: false },
    durationMs: Date.now() - startedAt,
    reason,
  };
}

function translateResponse(
  resp: AgentResponse,
  opts: ExecOpts,
  startedAt: number,
): ExecResult {
  // Truncate on the host side against opts.maxOutputBytes — the agent
  // has its own per-stream cap but the host's cap is the source of
  // truth at the substrate boundary (matches WASM/Native).
  const stdoutCap = truncate(resp.stdout, opts.maxOutputBytes);
  const stderrCap = truncate(resp.stderr, opts.maxOutputBytes);
  const truncated = {
    stdout: stdoutCap.truncated || resp.truncated_stdout,
    stderr: stderrCap.truncated || resp.truncated_stderr,
  };
  const base = {
    stdout: stdoutCap.text,
    stderr: stderrCap.text,
    truncated,
    durationMs: Date.now() - startedAt,
  };
  switch (resp.status) {
    case 'completed':
      return {
        ...base,
        status: 'completed',
        exitCode: resp.exit_code ?? 0,
        reason: resp.reason ?? undefined,
      };
    case 'timeout':
      return {
        ...base,
        status: 'timeout',
        reason: resp.reason ?? `wall-clock timeout (${opts.timeout}s)`,
      };
    case 'oom':
      return {
        ...base,
        status: 'oom',
        reason: resp.reason ?? `memory limit reached (${opts.memory} MB)`,
      };
    case 'egress_denied':
      return {
        ...base,
        status: 'egress_denied',
        reason: resp.reason ?? 'egress denied by substrate',
      };
    case 'crashed':
    default:
      return {
        ...base,
        status: 'crashed',
        reason: resp.reason ?? 'agent reported crashed with no reason',
      };
  }
}

/** Wait up to `timeoutMs` for the Firecracker API socket to appear. */
async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Firecracker API socket did not appear at ${path} within ${timeoutMs}ms`);
}

/** PUT `body` to the API socket; throw if the response isn't 204. */
async function apiPutExpect204(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<void> {
  const bodyStr = JSON.stringify(body);
  const { statusCode, responseBody } = await new Promise<{
    statusCode: number;
    responseBody: string;
  }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: 'PUT',
        path,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            responseBody: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
  if (statusCode !== 204) {
    throw new Error(
      `Firecracker API PUT ${path} returned ${statusCode}: ${responseBody}`,
    );
  }
}

