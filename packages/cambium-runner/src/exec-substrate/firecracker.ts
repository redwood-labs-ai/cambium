/**
 * `:firecracker` substrate — microVM isolation (RED-251 / RED-256).
 *
 * Three dispatch paths, all ending in the same vsock ExecRequest /
 * ExecResponse exchange with the RED-255 guest agent:
 *
 *   1. Warm-restore  — cache hit, restore from memfile+snapshot,
 *                      resume, dial, round-trip, destroy.
 *   2. Cold-and-save — cache miss under canonical sizing: full
 *                      cold-boot + pause + snapshot + resume +
 *                      round-trip, so the next call hits the cache.
 *   3. Cold-only     — non-canonical sizing, snapshot disabled, or
 *                      any snapshot-path failure: full cold-boot
 *                      + round-trip, no snapshot interaction.
 *
 * Kernel + rootfs paths are operator-level config (not per-gen), read
 * from env:
 *
 *   CAMBIUM_FC_KERNEL   path to vmlinux
 *   CAMBIUM_FC_ROOTFS   path to rootfs.ext4 (the RED-255 image)
 *
 * Optional:
 *
 *   CAMBIUM_FC_SNAPSHOT_DIR   override cache root (default: a `var/
 *                             snapshots/` directory next to the
 *                             runner's source tree)
 *   CAMBIUM_FC_DISABLE_SNAPSHOTS=1   force cold-only path (escape
 *                                    hatch for debugging or hosts
 *                                    where the shared-mmap backend
 *                                    isn't working)
 *
 * `available()` returns null only when Linux + KVM + firecracker
 * binary + both kernel/rootfs env vars are all present.
 *
 * v1 policy scope (deliberately narrow, matching what the testbed
 * proves):
 *
 *   - `network: 'none'` only. An allowlist errors with a pointer
 *     to the RED-259 follow-up.
 *   - `filesystem: 'none'` only. Allowlist_paths errors with a
 *     pointer to the RED-258 follow-up.
 *
 * Snapshot design decisions come from RED-256 and are implemented
 * in `firecracker-snapshot.ts`:
 *
 *   - Shared-mmap (`File` backend) restore, not per-call ext4 copy.
 *   - One canonical machine-config (1 vCPU, 512 MiB); non-canonical
 *     cold-boots and records `non_canonical_sizing` in the trace.
 *   - Workspace-local cache keyed by SHA-256 of (rootfs, kernel,
 *     canonical machine-config). In-process digest cache on
 *     (path, size, mtime).
 *   - First-miss snapshot save is inline; no background warmer.
 *
 * The RED-256 snapshot-spike (100 iterations on the MS-R1) measured
 * p95 3.4 ms from `PATCH /vm Resumed` to the first dial completing
 * the CONNECT handshake — direct-dial is viable, no retry needed.
 */

import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';
import type { NetworkPolicy } from '../tools/permissions.js';
import {
  VSOCK_GUEST_PORT,
  dialAndHandshake,
  writeFrame,
  readFrame,
  type BufferedSocketLike,
} from './firecracker-protocol.js';
import {
  apiPutExpect204,
  makeLogAccumulator,
  killFirecracker,
  spawnFirecracker,
  waitForApiSocket,
  FC_BINARY,
  type LogAccumulator,
} from './firecracker-api.js';
import {
  AGENT_INIT_PATH,
  CANONICAL_MACHINE_CONFIG,
  GUEST_CID,
  defaultCacheRoot,
  handleFor,
  isCanonicalSizing,
  restoreFromSnapshot,
  saveTemplateInline,
  snapshotExists,
  type FallbackReason,
  type SnapshotHandle,
} from './firecracker-snapshot.js';

const KERNEL_ENV = 'CAMBIUM_FC_KERNEL';
const ROOTFS_ENV = 'CAMBIUM_FC_ROOTFS';
const SNAPSHOT_DIR_ENV = 'CAMBIUM_FC_SNAPSHOT_DIR';
const DISABLE_SNAPSHOTS_ENV = 'CAMBIUM_FC_DISABLE_SNAPSHOTS';

/**
 * Agent-side ExecResponse shape (matches `crates/cambium-agent/src/
 * protocol.rs`). Private to the substrate — agent wire format is
 * the substrate's contract, not a cross-module type.
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
  'completed', 'timeout', 'oom', 'egress_denied', 'crashed',
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

/** Lexical search for `firecracker` on $PATH. Kept synchronous +
 *  side-effect-free so `available()` stays that way. */
function firecrackerOnPath(): boolean {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, FC_BINARY), constants.X_OK);
      return true;
    } catch { /* next */ }
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

    const scopeError = checkScope(opts);
    if (scopeError) return crashed(startedAt, scopeError);

    const reason = this.available();
    if (reason !== null) return crashed(startedAt, reason);

    // Re-validate rootfs at dispatch time — available() caches at
    // startup, so a rootfs removed since then would otherwise
    // surface as a copyFileSync exception mid-try.
    const rootfsPath = process.env[ROOTFS_ENV];
    if (!rootfsPath || !existsSync(rootfsPath)) {
      return crashed(
        startedAt,
        `${ROOTFS_ENV}=${rootfsPath ?? ''} does not point to an existing rootfs.ext4 file at dispatch time (was valid at startup, changed since).`,
      );
    }
    const kernelPath = process.env[KERNEL_ENV]!;
    const cacheRoot = process.env[SNAPSHOT_DIR_ENV] ?? defaultCacheRoot();
    const snapshotsDisabled = process.env[DISABLE_SNAPSHOTS_ENV] === '1';

    // Branch: warm-restore, cold-and-save, or cold-only.
    if (snapshotsDisabled) {
      return executeCold(opts, rootfsPath, kernelPath, startedAt);
    }
    if (!isCanonicalSizing(opts)) {
      return executeCold(opts, rootfsPath, kernelPath, startedAt, {
        snapshotFallbackReason: 'non_canonical_sizing',
      });
    }

    let handle: SnapshotHandle;
    try {
      handle = await handleFor(rootfsPath, kernelPath, cacheRoot);
    } catch (e: any) {
      // Hash failure (e.g. rootfs unreadable between existsSync and
      // read). Fall back to cold without trying to snapshot.
      return executeCold(opts, rootfsPath, kernelPath, startedAt, {
        snapshotFallbackReason: 'load_failed',
      });
    }

    if (snapshotExists(handle)) {
      return executeWarm(opts, rootfsPath, kernelPath, handle, startedAt);
    }
    return executeColdAndSave(opts, rootfsPath, kernelPath, handle, startedAt);
  }
}

// ── Shared dispatch pieces ──────────────────────────────────────────

interface RunContext {
  workDir: string;
  apiSock: string;
  vsockUds: string;
  stagedRootfs: string;
  log: LogAccumulator;
  runId: string;
}

function makeRunContext(): RunContext {
  const workDir = mkdtempSync(join(tmpdir(), 'cambium-fc-'));
  const runId = randomBytes(4).toString('hex');
  return {
    workDir,
    apiSock: join(workDir, `fc-${runId}.api.sock`),
    vsockUds: join(workDir, `fc-${runId}.vsock.sock`),
    stagedRootfs: join(workDir, 'rootfs.ext4'),
    log: makeLogAccumulator(),
    runId,
  };
}

function cleanupRunContext(ctx: RunContext, fc: ChildProcess | null, sock: BufferedSocketLike | null): void {
  try { sock?.destroy(); } catch { /* ignore */ }
  killFirecracker(fc);
  try { rmSync(ctx.workDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Drive a fresh firecracker through the full cold-boot sequence,
 *  ending with a dialed + handshaked vsock socket ready to carry
 *  one ExecRequest. Used by both executeCold and executeColdAndSave. */
async function coldBootToAccept(
  opts: ExecOpts,
  kernelPath: string,
  ctx: RunContext,
): Promise<{ fc: ChildProcess; sock: BufferedSocketLike; bootDeadline: number }> {
  const fc = spawnFirecracker(ctx.apiSock, ctx.log);
  await waitForApiSocket(ctx.apiSock, 5_000);
  const bootDeadline = Date.now() + 20_000;

  await apiPutExpect204(ctx.apiSock, '/machine-config', {
    vcpu_count: Math.max(1, Math.round(opts.cpu)),
    mem_size_mib: Math.max(16, Math.round(opts.memory)),
  });
  await apiPutExpect204(ctx.apiSock, '/boot-source', {
    kernel_image_path: kernelPath,
    boot_args: `console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=${AGENT_INIT_PATH}`,
  });
  await apiPutExpect204(ctx.apiSock, '/drives/rootfs', {
    drive_id: 'rootfs',
    path_on_host: ctx.stagedRootfs,
    is_root_device: true,
    is_read_only: false,
  });
  await apiPutExpect204(ctx.apiSock, '/vsock', {
    vsock_id: 'vsock0',
    guest_cid: GUEST_CID,
    uds_path: ctx.vsockUds,
  });
  await apiPutExpect204(ctx.apiSock, '/actions', { action_type: 'InstanceStart' });

  const { sock } = await dialAndHandshake(ctx.vsockUds, VSOCK_GUEST_PORT, bootDeadline);
  return { fc, sock, bootDeadline };
}

/** Drive the canonical cold-boot sequence for template creation.
 *  Same shape as coldBootToAccept but forces the canonical machine-
 *  config regardless of what the caller's ExecOpts asked for. */
async function coldBootCanonicalToAccept(
  kernelPath: string,
  ctx: RunContext,
): Promise<{ fc: ChildProcess; sock: BufferedSocketLike }> {
  const fc = spawnFirecracker(ctx.apiSock, ctx.log);
  await waitForApiSocket(ctx.apiSock, 5_000);
  const bootDeadline = Date.now() + 20_000;

  await apiPutExpect204(ctx.apiSock, '/machine-config', CANONICAL_MACHINE_CONFIG);
  await apiPutExpect204(ctx.apiSock, '/boot-source', {
    kernel_image_path: kernelPath,
    boot_args: `console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=${AGENT_INIT_PATH}`,
  });
  await apiPutExpect204(ctx.apiSock, '/drives/rootfs', {
    drive_id: 'rootfs',
    path_on_host: ctx.stagedRootfs,
    is_root_device: true,
    is_read_only: false,
  });
  await apiPutExpect204(ctx.apiSock, '/vsock', {
    vsock_id: 'vsock0',
    guest_cid: GUEST_CID,
    uds_path: ctx.vsockUds,
  });
  await apiPutExpect204(ctx.apiSock, '/actions', { action_type: 'InstanceStart' });

  const { sock } = await dialAndHandshake(ctx.vsockUds, VSOCK_GUEST_PORT, bootDeadline);
  return { fc, sock };
}

/** Send ExecRequest over an already-handshaked socket and read
 *  ExecResponse. Shared by all three dispatch paths. */
async function runExecAgainst(
  opts: ExecOpts,
  sock: BufferedSocketLike,
  responseDeadline: number,
  startedAt: number,
): Promise<ExecResult> {
  writeFrame(sock, {
    language: opts.language,
    code: opts.code,
    cpu: opts.cpu,
    memory_mb: Math.max(16, Math.round(opts.memory)),
    timeout_seconds: Math.max(1, Math.round(opts.timeout)),
    max_output_bytes: opts.maxOutputBytes,
  });
  const readTimeoutMs = Math.max(1_000, responseDeadline - Date.now());
  const raw = await readFrame(sock, readTimeoutMs);
  if (!isAgentResponse(raw)) {
    return crashed(
      startedAt,
      `agent returned unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return translateResponse(raw, opts, startedAt);
}

// ── The three paths ──────────────────────────────────────────────────

async function executeCold(
  opts: ExecOpts,
  rootfsPath: string,
  kernelPath: string,
  startedAt: number,
  meta: { snapshotFallbackReason?: FallbackReason; cacheKey?: string } = {},
): Promise<ExecResult> {
  const ctx = makeRunContext();
  let fc: ChildProcess | null = null;
  let sock: BufferedSocketLike | null = null;
  try {
    copyFileSync(rootfsPath, ctx.stagedRootfs);
    const booted = await coldBootToAccept(opts, kernelPath, ctx);
    fc = booted.fc;
    sock = booted.sock;
    const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
    const result = await runExecAgainst(opts, sock, responseDeadline, startedAt);
    return withSnapshotMeta(result, meta.snapshotFallbackReason
      ? { path: 'cold_boot_fallback', fallbackReason: meta.snapshotFallbackReason, cacheKey: meta.cacheKey }
      : undefined);
  } catch (e: any) {
    return crashedWithLog(startedAt, ctx, e);
  } finally {
    cleanupRunContext(ctx, fc, sock);
  }
}

async function executeColdAndSave(
  opts: ExecOpts,
  rootfsPath: string,
  kernelPath: string,
  handle: SnapshotHandle,
  startedAt: number,
): Promise<ExecResult> {
  const ctx = makeRunContext();
  let fc: ChildProcess | null = null;
  let sock: BufferedSocketLike | null = null;
  try {
    copyFileSync(rootfsPath, ctx.stagedRootfs);
    // Canonical boot — we're also saving a template, so we must
    // match what the cache is keyed on even if the caller's opts
    // were equivalent after normalization.
    const booted = await coldBootCanonicalToAccept(kernelPath, ctx);
    fc = booted.fc;
    sock = booted.sock;

    // Close this bootstrap handshake BEFORE snapshotting — we want
    // the template state to be "agent in accept()", not "agent
    // handling a request." The agent's handle_one() reads one frame
    // header; a half-closed stream resolves to EOF on its end and
    // the agent loops back to accept. Dropping `sock` triggers that.
    try { sock.destroy(); } catch { /* ignore */ }
    sock = null;
    // Brief settle window so the agent has time to return from the
    // handle_one error path and reach accept() before we snapshot.
    await new Promise((r) => setTimeout(r, 250));

    let createMs: number;
    try {
      createMs = await saveTemplateInline(ctx.apiSock, handle);
    } catch (e: any) {
      // Snapshot save failed; degrade to pure cold-boot for this
      // request. We've already torn down the dial; re-dial to run
      // the ExecRequest.
      const redial = await dialAndHandshake(
        ctx.vsockUds,
        VSOCK_GUEST_PORT,
        Date.now() + 10_000,
      );
      sock = redial.sock;
      const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
      const result = await runExecAgainst(opts, sock, responseDeadline, startedAt);
      return withSnapshotMeta(result, {
        path: 'cold_boot_fallback',
        fallbackReason: 'load_failed',
        cacheKey: handle.cacheKey,
      });
    }

    // Template saved. Re-dial and run the user's ExecRequest against
    // the SAME VM (now resumed). The template on disk is clean; the
    // live VM can carry the current request.
    const redial = await dialAndHandshake(
      ctx.vsockUds,
      VSOCK_GUEST_PORT,
      Date.now() + 10_000,
    );
    sock = redial.sock;
    const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
    const result = await runExecAgainst(opts, sock, responseDeadline, startedAt);
    return withSnapshotMeta(result, {
      path: 'cold_boot_and_save',
      createMs,
      cacheKey: handle.cacheKey,
    });
  } catch (e: any) {
    return crashedWithLog(startedAt, ctx, e);
  } finally {
    cleanupRunContext(ctx, fc, sock);
  }
}

async function executeWarm(
  opts: ExecOpts,
  rootfsPath: string,
  kernelPath: string,
  handle: SnapshotHandle,
  startedAt: number,
): Promise<ExecResult> {
  const ctx = makeRunContext();
  let fc: ChildProcess | null = null;
  let sock: BufferedSocketLike | null = null;
  try {
    // Stage the rootfs even on the warm path — Firecracker's
    // restore reads the drive from whatever path is baked into the
    // snapshot, but v1.5 keeps the rootfs staged at the workdir for
    // uniformity with cold-boot. Firecracker tolerates this because
    // the restored drive config uses an absolute path (the staged
    // path at template-build time); as long as the content is
    // identical it's fine. TODO: revisit if staging becomes a hot
    // path — we're paying a ~100ms copy on every warm call.
    copyFileSync(rootfsPath, ctx.stagedRootfs);

    let restored;
    try {
      restored = await restoreFromSnapshot(handle, ctx.apiSock, ctx.vsockUds, ctx.log);
    } catch (e: any) {
      // Snapshot load failed. Fall through to cold-boot. The
      // snapshot ISN'T invalidated — could be a transient API
      // error; the next call with identical inputs will try again.
      const fallback = await executeCold(opts, rootfsPath, kernelPath, startedAt, {
        snapshotFallbackReason: 'load_failed',
        cacheKey: handle.cacheKey,
      });
      return fallback;
    }
    fc = restored.fc;
    sock = restored.sock;

    const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
    const result = await runExecAgainst(opts, sock, responseDeadline, startedAt);
    return withSnapshotMeta(result, {
      path: 'warm_restore',
      restoreMs: restored.restoreMs,
      cacheKey: handle.cacheKey,
    });
  } catch (e: any) {
    return crashedWithLog(startedAt, ctx, e);
  } finally {
    cleanupRunContext(ctx, fc, sock);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function checkScope(opts: ExecOpts): string | null {
  if (opts.network !== 'none') {
    const np = opts.network as NetworkPolicy;
    return `:firecracker v1 supports network: 'none' only (got allowlist: ${
      np?.allowlist?.join(', ') ?? 'unknown'
    }). Host-side netns + iptables resolution is RED-259; for network access, use runtime: :native (unsandboxed) or file a ticket.`;
  }
  if (opts.filesystem !== 'none') {
    const paths = (opts.filesystem as { allowlist_paths?: string[] })
      ?.allowlist_paths?.join(', ') ?? '(no allowlist_paths)';
    return `:firecracker v1 supports filesystem: 'none' only (got allowlist_paths: ${paths}). Host-side bind-mount drive resolution is RED-258; for filesystem access, use runtime: :native (unsandboxed) or file a ticket.`;
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

function crashedWithLog(startedAt: number, ctx: RunContext, e: any): ExecResult {
  const base = e?.message ?? String(e);
  const tail = ctx.log.tail(30);
  const reason = tail
    ? `${base}\n--- firecracker log tail ---\n${tail}`
    : base;
  return crashed(startedAt, reason);
}

function withSnapshotMeta(
  result: ExecResult,
  snapshot?: ExecResult['snapshot'],
): ExecResult {
  if (!snapshot) return result;
  return { ...result, snapshot };
}

function translateResponse(
  resp: AgentResponse,
  opts: ExecOpts,
  startedAt: number,
): ExecResult {
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
