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
 * v1 policy scope:
 *
 *   - `network: 'none'` only. An allowlist errors with a pointer
 *     to the RED-259 follow-up.
 *   - `filesystem: 'none'` OR `{ allowlist_paths: [...] }` with
 *     read-only per-allowlist ext4 mounts (RED-258). The host
 *     builds one ext4 per allowlisted path via `mke2fs -d`, caches
 *     it in the snapshot cache dir, attaches it as virtio-blk, and
 *     the agent mounts it at the declared guest path before
 *     spawning the interpreter.
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
  apiPatchExpect204,
  apiPutExpect204,
  makeLogAccumulator,
  drainFirecracker,
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
  createSnapshot,
  defaultCacheRoot,
  ensureCacheDir,
  handleFor,
  isCanonicalSizing,
  releaseCacheLock,
  resolveCacheRoot,
  restoreFromSnapshot,
  snapshotExists,
  tryAcquireCacheLock,
  type FallbackReason,
  type SnapshotHandle,
} from './firecracker-snapshot.js';
import {
  buildAllowlistDrives,
  drivesToAgentMounts,
  formatAllowlistError,
  hashAllowlist,
  normalizeAllowlistPaths,
  type AgentMount,
  type AllowlistDrive,
  type AllowlistEntry,
} from './firecracker-allowlist.js';
import { resolveAllowlist, type ResolvedAllowlist } from './firecracker-dns.js';
import {
  GUEST_IP_CIDR,
  GUEST_MAC,
  TAP,
  TAP_IP,
  chmodSocketIfNetns,
  setupNetns,
  teardownNetns,
  type NetnsHandle,
} from './firecracker-netns.js';

/** Network scope distinguished at resolveScope: 'none' preserves the
 *  original no-netns flow; 'policy' triggers the full RED-259 path
 *  (netns setup, virtio-net attach, NetConfig to agent). */
type NetworkScope =
  | { kind: 'none' }
  | { kind: 'policy'; policy: NetworkPolicy };

/** Agent-side NetConfig shape. Matches `NetConfig` in
 *  `crates/cambium-agent/src/protocol.rs`. Kept here as a private
 *  substrate contract — the agent wire format is the substrate's
 *  responsibility. */
interface AgentNetConfig {
  iface_ip: string;
  gateway: string;
  hosts: Array<{ name: string; ip: string }>;
}

/** Build the NetConfig the guest agent needs from a ResolvedAllowlist.
 *  Pure function; netns constants supply the fixed iface_ip / gateway. */
function buildAgentNetConfig(resolved: ResolvedAllowlist): AgentNetConfig {
  return {
    iface_ip: GUEST_IP_CIDR,
    gateway: TAP_IP,
    hosts: resolved.hosts.map((h) => ({ name: h.name, ip: h.ip })),
  };
}

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
  // Validate the snapshot cache root BEFORE a dispatch can try to
  // join a traversal-bearing value into path.join. Operator env var;
  // fail fast at availability time if misconfigured.
  const snapshotDir = process.env[SNAPSHOT_DIR_ENV];
  if (snapshotDir) {
    const resolved = resolveCacheRoot(snapshotDir);
    if (typeof resolved !== 'string') {
      return `${SNAPSHOT_DIR_ENV}=${snapshotDir} is invalid: ${resolved.error}`;
    }
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

    const scope = resolveScope(opts);
    if ('error' in scope) return crashed(startedAt, scope.error);
    const allowlist = scope.allowlist;
    const networkScope = scope.networkScope;

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
    const snapshotsDisabled = process.env[DISABLE_SNAPSHOTS_ENV] === '1';

    // Branch: warm-restore, cold-and-save, or cold-only.
    //
    // Network policy forces cold-only in v1: the virtio-net device is
    // baked into the snapshot at save time, and a saved snapshot holds
    // a specific tap device reference. Combining net-allowlist with
    // warm-restore is a v1.5 optimization (needs a net-enabled vs
    // net-disabled cache-key axis). For now, gens using network
    // policy pay ~200ms per-call cold-boot overhead.
    if (networkScope.kind === 'policy') {
      return executeCold(opts, rootfsPath, kernelPath, allowlist, networkScope, startedAt);
    }
    if (snapshotsDisabled) {
      return executeCold(opts, rootfsPath, kernelPath, allowlist, networkScope, startedAt);
    }
    if (!isCanonicalSizing(opts)) {
      return executeCold(opts, rootfsPath, kernelPath, allowlist, networkScope, startedAt, {
        snapshotFallbackReason: 'non_canonical_sizing',
      });
    }

    // Cache root — validated at available() but re-resolved here
    // (cheap) because we want the absolute, normalized form.
    const cacheRootEnv = process.env[SNAPSHOT_DIR_ENV];
    const cacheRootResult = cacheRootEnv ? resolveCacheRoot(cacheRootEnv) : defaultCacheRoot();
    if (typeof cacheRootResult !== 'string') {
      // Should have been caught at available() — defensive only.
      return crashed(startedAt, `${SNAPSHOT_DIR_ENV} invalid: ${cacheRootResult.error}`);
    }
    const cacheRoot = cacheRootResult;

    // Allowlist signature participates in the cache key — different
    // allowlists must map to different snapshots because virtio-blk
    // drives get baked into the snapshot at template-build time and
    // can't be attached to a restored VM.
    let allowlistSig: string;
    try {
      allowlistSig = hashAllowlist(allowlist);
    } catch (e: any) {
      // Hashing can throw if a source dir is huge (> max entries) or
      // unreadable. Fall back to cold-only with a reason that names
      // the allowlist as the cause — `load_failed` would be
      // misleading here because no snapshot load was ever attempted.
      return executeCold(opts, rootfsPath, kernelPath, allowlist, networkScope, startedAt, {
        snapshotFallbackReason: 'allowlist_hash_failed',
      });
    }

    let handle: SnapshotHandle;
    try {
      handle = await handleFor(rootfsPath, kernelPath, allowlistSig, cacheRoot);
    } catch (e: any) {
      // Hash failure (e.g. rootfs unreadable between existsSync and
      // read). Fall back to cold without trying to snapshot.
      return executeCold(opts, rootfsPath, kernelPath, allowlist, networkScope, startedAt, {
        snapshotFallbackReason: 'load_failed',
      });
    }

    if (snapshotExists(handle)) {
      return executeWarm(opts, rootfsPath, kernelPath, allowlist, handle, startedAt);
    }
    return executeColdAndSave(opts, rootfsPath, kernelPath, allowlist, handle, startedAt);
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

/** Attach each allowlist drive via `PUT /drives/<drive_id>`. Must
 *  happen BEFORE `PUT /actions InstanceStart`; Firecracker doesn't
 *  support hot-attach. Drive order determines the guest-side device
 *  path (`/dev/vdb`, `/dev/vdc`, ...) the agent will mount. */
async function attachAllowlistDrives(
  apiSock: string,
  drives: AllowlistDrive[],
): Promise<void> {
  for (const d of drives) {
    await apiPutExpect204(apiSock, `/drives/${d.driveId}`, {
      drive_id: d.driveId,
      path_on_host: d.imagePath,
      is_root_device: false,
      is_read_only: d.readOnly,
    });
  }
}

/** Drive a fresh firecracker through the full cold-boot sequence,
 *  ending with a dialed + handshaked vsock socket ready to carry
 *  one ExecRequest. Used by both executeCold and executeColdAndSave. */
async function coldBootToAccept(
  opts: ExecOpts,
  kernelPath: string,
  allowlistDrives: AllowlistDrive[],
  netnsHandle: NetnsHandle | null,
  ctx: RunContext,
): Promise<{ fc: ChildProcess; sock: BufferedSocketLike; bootDeadline: number }> {
  const fc = spawnFirecracker(ctx.apiSock, ctx.log, netnsHandle ? { netns: netnsHandle.netns } : {});
  await waitForApiSocket(ctx.apiSock, 5_000);
  // FC running under sudo (netns path) creates the API socket as
  // root with default 0755 perms; the unprivileged runner can't
  // connect (EACCES on the first apiPutExpect204). chmod 0666 lets
  // the connect through. No-op when there's no netns.
  await chmodSocketIfNetns(netnsHandle, ctx.apiSock);
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
  await attachAllowlistDrives(ctx.apiSock, allowlistDrives);
  // Attach virtio-net when a netns is present. The tap was created
  // inside the netns during `setupNetns`; FC (running inside the
  // same netns via ip netns exec) opens it by name. GUEST_MAC is
  // fixed so the guest-side ARP cache + agent's /etc/hosts entries
  // stay stable across runs.
  if (netnsHandle) {
    await apiPutExpect204(ctx.apiSock, `/network-interfaces/eth0`, {
      iface_id: 'eth0',
      host_dev_name: netnsHandle.tap,
      guest_mac: GUEST_MAC,
    });
  }
  await apiPutExpect204(ctx.apiSock, '/vsock', {
    vsock_id: 'vsock0',
    guest_cid: GUEST_CID,
    uds_path: ctx.vsockUds,
  });
  // The vsock UDS is created by FC at PUT /vsock time, again as root
  // when running under sudo. Same chmod treatment as the API socket
  // so dialAndHandshake (below) can connect.
  await chmodSocketIfNetns(netnsHandle, ctx.vsockUds);
  await apiPutExpect204(ctx.apiSock, '/actions', { action_type: 'InstanceStart' });

  const { sock } = await dialAndHandshake(ctx.vsockUds, VSOCK_GUEST_PORT, bootDeadline);
  return { fc, sock, bootDeadline };
}

/** Cold-boot with the canonical machine-config, against specific
 *  rootfs + vsock-UDS paths. Used by executeColdAndSave — both paths
 *  live in the cache directory (not a per-call tempdir), because
 *  the snapshot file bakes both of them and warm restores later
 *  reopen them. Using tempdir paths here would leave warm restores
 *  trying to bind a UDS whose parent directory was deleted in
 *  cleanup. */
async function coldBootCanonical(
  kernelPath: string,
  rootfsPath: string,
  vsockUdsPath: string,
  allowlistDrives: AllowlistDrive[],
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
    path_on_host: rootfsPath,
    is_root_device: true,
    is_read_only: false,
  });
  await attachAllowlistDrives(ctx.apiSock, allowlistDrives);
  await apiPutExpect204(ctx.apiSock, '/vsock', {
    vsock_id: 'vsock0',
    guest_cid: GUEST_CID,
    uds_path: vsockUdsPath,
  });
  await apiPutExpect204(ctx.apiSock, '/actions', { action_type: 'InstanceStart' });

  const { sock } = await dialAndHandshake(vsockUdsPath, VSOCK_GUEST_PORT, bootDeadline);
  return { fc, sock };
}

/** Send ExecRequest over an already-handshaked socket and read
 *  ExecResponse. Shared by all three dispatch paths. `mounts` is
 *  the per-allowlist-drive metadata the agent uses to `mount -t
 *  ext4 <device> <guest_path>` before spawning the interpreter;
 *  empty for gens with no filesystem allowlist. */
async function runExecAgainst(
  opts: ExecOpts,
  sock: BufferedSocketLike,
  mounts: AgentMount[],
  net: AgentNetConfig | null,
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
    mounts,
    // `net` is included unconditionally. When null, serde on the
    // agent side treats a missing or explicit-null `net` the same
    // (Option<NetConfig> + #[serde(default)]). When an object, the
    // agent brings eth0 up and writes /etc/hosts before spawning
    // the interpreter.
    net,
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
  allowlist: AllowlistEntry[],
  networkScope: NetworkScope,
  startedAt: number,
  meta: { snapshotFallbackReason?: FallbackReason; cacheKey?: string } = {},
): Promise<ExecResult> {
  const ctx = makeRunContext();
  let fc: ChildProcess | null = null;
  let sock: BufferedSocketLike | null = null;
  let netnsHandle: NetnsHandle | null = null;
  let agentNet: AgentNetConfig | null = null;
  try {
    copyFileSync(rootfsPath, ctx.stagedRootfs);

    // Network path (RED-259): resolve allowlist hostnames via host
    // DNS, setup the netns + tap + iptables + return route, build
    // the NetConfig the agent needs. Resolution happens BEFORE
    // netns setup so a bad allowlist fails fast without any
    // privileged ops. If anything here throws, the finally block
    // tears down whatever partial state exists.
    if (networkScope.kind === 'policy') {
      const resolved = await resolveAllowlist(networkScope.policy);
      netnsHandle = await setupNetns({
        policy: networkScope.policy,
        allowedIps: resolved.allowedIps,
      });
      agentNet = buildAgentNetConfig(resolved);
    }

    // Build per-call allowlist drives in the tempdir. They're
    // disposable (same lifecycle as the rootfs copy) since cold-only
    // doesn't persist any cache state.
    const allowlistDrives = buildAllowlistDrives(allowlist, ctx.workDir);
    const booted = await coldBootToAccept(opts, kernelPath, allowlistDrives, netnsHandle, ctx);
    fc = booted.fc;
    sock = booted.sock;
    const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
    const mounts = drivesToAgentMounts(allowlistDrives);
    const result = await runExecAgainst(opts, sock, mounts, agentNet, responseDeadline, startedAt);
    return withSnapshotMeta(result, meta.snapshotFallbackReason
      ? { path: 'cold_boot_fallback', fallbackReason: meta.snapshotFallbackReason, cacheKey: meta.cacheKey }
      : undefined);
  } catch (e: any) {
    return crashedWithLog(startedAt, ctx, e);
  } finally {
    cleanupRunContext(ctx, fc, sock);
    // Netns teardown MUST happen after FC has released the tap fd.
    // cleanupRunContext sends SIGKILL but doesn't wait; without an
    // explicit drain, tearing down the tap while FC still holds its
    // fd leaks kernel state (the tap persists under the fd and
    // `ip netns delete` silently fails). drainFirecracker awaits the
    // exit event with a 1s deadline — SIGKILL is immediate at the
    // kernel level so the typical wait is microseconds.
    if (netnsHandle) {
      try { await drainFirecracker(fc); } catch { /* best-effort */ }
      try { await teardownNetns(netnsHandle); } catch { /* best-effort */ }
    }
  }
}

async function executeColdAndSave(
  opts: ExecOpts,
  rootfsPath: string,
  kernelPath: string,
  allowlist: AllowlistEntry[],
  handle: SnapshotHandle,
  startedAt: number,
): Promise<ExecResult> {
  // Prepare the cache directory + acquire the exclusive lock before
  // any VM work. If another caller is already building this template
  // (or running a warm restore against it), fall back to pure cold-
  // boot rather than racing.
  ensureCacheDir(handle);
  const lockFd = tryAcquireCacheLock(handle);
  if (lockFd === null) {
    return executeCold(opts, rootfsPath, kernelPath, allowlist, { kind: 'none' }, startedAt, {
      snapshotFallbackReason: 'build_locked',
      cacheKey: handle.cacheKey,
    });
  }

  // Outer try/finally ensures the lock is ALWAYS released — even
  // when phase 1 returns early on snapshot-save failure, even when
  // phase 1's crashedWithLog catch fires, even when anything in
  // phase 2 throws. `tryAcquireCacheLock` uses O_CREAT | O_EXCL
  // (a real filesystem lockfile, not an OS-level advisory lock
  // that auto-releases on fd close), so a leak here would leave
  // the cache entry permanently locked — all future calls would
  // fall through to cold-only with `build_locked` until an
  // operator manually removed the lockfile. Flagged by
  // cambium-security's post-R1 follow-up review.
  try {
    // Phase 1: cold-boot the TEMPLATE VM, verify agent, snapshot,
    // destroy. The template VM exists only to produce the snapshot;
    // we don't run the user's ExecRequest against it. Attempting to
    // reuse the same VM after snapshot + resume doesn't reliably
    // re-dial (observed on R1 as 12s timeouts even though the
    // snapshot saved cleanly). Destroying the template + restoring
    // in a fresh FC matches what `executeWarm` does, and warm works,
    // so both paths route the user request through the same
    // restoreFromSnapshot code.
    const templateCtx = makeRunContext();
    let templateFc: ChildProcess | null = null;
    let templateSock: BufferedSocketLike | null = null;
    let createMs = 0;
    let phase1Degraded = false;
    // Allowlist drives live in the cache directory alongside the
    // rootfs + memfile. Built once per cache entry; warm restores
    // reuse the same image paths (they're baked into the snapshot).
    let allowlistDrivesForTemplate: AllowlistDrive[];
    try {
      copyFileSync(rootfsPath, handle.rootfsFile);
      try { rmSync(handle.vsockUdsFile, { force: true }); } catch { /* ignore */ }
      allowlistDrivesForTemplate = buildAllowlistDrives(allowlist, handle.dir);

      const booted = await coldBootCanonical(
        kernelPath,
        handle.rootfsFile,
        handle.vsockUdsFile,
        allowlistDrivesForTemplate,
        templateCtx,
      );
      templateFc = booted.fc;
      templateSock = booted.sock;

      try { templateSock.destroy(); } catch { /* ignore */ }
      templateSock = null;
      // Settle window — RED-256 spike measured ~3ms p95 for guest
      // accept() to wake on dial; 250ms is 80× that. Replace with
      // probe-based detection if flaky under real host load.
      await new Promise((r) => setTimeout(r, 250));

      const t0 = Date.now();
      try {
        await apiPatchExpect204(templateCtx.apiSock, '/vm', { state: 'Paused' });
        await createSnapshot(templateCtx.apiSock, handle);
        createMs = Date.now() - t0;
      } catch (e: any) {
        // Snapshot save failed. Degrade to pure cold-boot for the
        // user's request. Mark the phase as degraded so phase 2
        // skips the restore attempt.
        phase1Degraded = true;
      }
    } catch (e: any) {
      // Template boot / dial / pause / anything-else threw. Same
      // degraded outcome — log the tail, skip phase 2, fall back
      // to cold-only for the user's request.
      const degraded = crashedWithLog(startedAt, templateCtx, e);
      // If crashedWithLog had anything to say (firecracker log tail)
      // it's on `degraded.reason`; we preserve by threading through
      // executeCold below (which has its own error handling but
      // won't see the template's log). For now, return the template
      // crash directly — the user's request CAN'T run because we
      // couldn't even boot the VM once.
      return degraded;
    } finally {
      try { templateSock?.destroy(); } catch { /* ignore */ }
      killFirecracker(templateFc);
      try { rmSync(templateCtx.workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (phase1Degraded) {
      return withSnapshotMeta(
        await executeCold(opts, rootfsPath, kernelPath, allowlist, { kind: 'none' }, startedAt),
        { path: 'cold_boot_fallback', fallbackReason: 'load_failed', cacheKey: handle.cacheKey },
      );
    }

    // Phase 2: restore from the just-saved snapshot + run the user
    // ExecRequest. Same code path executeWarm uses — if that works,
    // this works. The allowlist drives were built in phase 1 (they're
    // in handle.dir). Recompute the drives list to derive the device
    // paths + agent-mount metadata we need for this phase; the
    // helper is idempotent (existsSync short-circuits the rebuild).
    const allowlistDrives = buildAllowlistDrives(allowlist, handle.dir);
    const mounts = drivesToAgentMounts(allowlistDrives);

    const ctx = makeRunContext();
    let fc: ChildProcess | null = null;
    let sock: BufferedSocketLike | null = null;
    try {
      let restored;
      try {
        restored = await restoreFromSnapshot(handle, ctx.apiSock, ctx.log);
      } catch (e: any) {
        return withSnapshotMeta(
          await executeCold(opts, rootfsPath, kernelPath, allowlist, { kind: 'none' }, startedAt),
          { path: 'cold_boot_fallback', fallbackReason: 'load_failed', cacheKey: handle.cacheKey },
        );
      }
      fc = restored.fc;
      sock = restored.sock;

      const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
      // executeColdAndSave / executeWarm never touch network policy
      // in v1 — the `execute()` dispatcher routes net-policy gens to
      // executeCold. Pass net:null explicitly.
      const result = await runExecAgainst(opts, sock, mounts, null, responseDeadline, startedAt);
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
  } finally {
    releaseCacheLock(handle, lockFd);
  }
}

async function executeWarm(
  opts: ExecOpts,
  rootfsPath: string,
  kernelPath: string,
  allowlist: AllowlistEntry[],
  handle: SnapshotHandle,
  startedAt: number,
): Promise<ExecResult> {
  // Acquire the exclusive lock before touching the cache entry.
  // Two parallel warm restores of the same cache key would both
  // write to the same `handle.rootfsFile` inside the guest (the
  // agent writes `/tmp/script.js`, which lands on the virtio-blk
  // drive) — that's a data-integrity hazard (guest A reads guest
  // B's script). Serializing per-cache-entry eliminates that;
  // different cache keys still run in parallel unaffected.
  const lockFd = tryAcquireCacheLock(handle);
  if (lockFd === null) {
    return executeCold(opts, rootfsPath, kernelPath, allowlist, { kind: 'none' }, startedAt, {
      snapshotFallbackReason: 'build_locked',
      cacheKey: handle.cacheKey,
    });
  }

  // Warm restores do NOT stage a per-call rootfs copy. The drive
  // path baked into the snapshot file is `handle.rootfsFile`, which
  // lives in the cache directory and persists across calls.
  // Firecracker opens that path on restore. (The per-call workdir
  // still holds the API socket and vsock UDS so those stay
  // per-call-unique.)
  const ctx = makeRunContext();
  let fc: ChildProcess | null = null;
  let sock: BufferedSocketLike | null = null;
  try {
    let restored;
    try {
      restored = await restoreFromSnapshot(handle, ctx.apiSock, ctx.log);
    } catch (e: any) {
      // Snapshot load failed. Fall through to cold-boot. The
      // snapshot ISN'T invalidated — could be a transient API
      // error; the next call with identical inputs will try again.
      // Cold-only doesn't interact with the cache, so holding the
      // lock through the fallback is safe (and keeps the lock
      // state simple — one release in the finally, always).
      return executeCold(opts, rootfsPath, kernelPath, allowlist, { kind: 'none' }, startedAt, {
        snapshotFallbackReason: 'load_failed',
        cacheKey: handle.cacheKey,
      });
    }
    fc = restored.fc;
    sock = restored.sock;

    // Allowlist drives are already in the cache dir (built at
    // template-save time); reconstitute the mount metadata from the
    // canonical allowlist so the agent knows where to mount each
    // drive. The ext4 images themselves are referenced by the
    // snapshot's baked drive config, no host-side re-attach needed.
    const allowlistDrives = buildAllowlistDrives(allowlist, handle.dir);
    const mounts = drivesToAgentMounts(allowlistDrives);

    const responseDeadline = Date.now() + opts.timeout * 1000 + 5_000;
    // Warm-restore is only reachable for networkScope.kind === 'none'
    // in v1 — see the dispatch branching in execute().
    const result = await runExecAgainst(opts, sock, mounts, null, responseDeadline, startedAt);
    return withSnapshotMeta(result, {
      path: 'warm_restore',
      restoreMs: restored.restoreMs,
      cacheKey: handle.cacheKey,
    });
  } catch (e: any) {
    return crashedWithLog(startedAt, ctx, e);
  } finally {
    cleanupRunContext(ctx, fc, sock);
    // releaseCacheLock is a no-op if already released (load-failed
    // path above); safe to call unconditionally.
    releaseCacheLock(handle, lockFd);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Validate the policy shape of an ExecOpts and normalize the
 * filesystem allowlist into structured entries. Returns either an
 * error string (to surface as `crashed`) or the normalized scope.
 *
 * Network accepts `'none'` OR a NetworkPolicy (RED-259): allowlist +
 * denylist + block_private + block_metadata. The policy itself is
 * validated shape-wise here; hostname resolution + iptables rule
 * generation happen later in the dispatch path (requires async +
 * system calls and shouldn't run before filesystem / availability
 * checks).
 *
 * Filesystem accepts `'none'` OR a validated, canonicalized allowlist
 * per RED-258. Validation covers absoluteness, normalized form,
 * rootfs-owned prefix collision, source directory existence, and
 * the `MAX_ALLOWLIST_ENTRIES` cap.
 */
function resolveScope(opts: ExecOpts):
  | { error: string }
  | { allowlist: AllowlistEntry[]; networkScope: NetworkScope } {
  // Network shape check. 'none' is the no-netns fast path; any other
  // value must be a NetworkPolicy (RED-137 shape) — we validate the
  // critical fields here and defer async resolution to dispatch time.
  let networkScope: NetworkScope;
  if (opts.network === 'none') {
    networkScope = { kind: 'none' };
  } else {
    const np = opts.network as NetworkPolicy;
    if (
      !np ||
      !Array.isArray(np.allowlist) ||
      !np.allowlist.every((e): e is string => typeof e === 'string') ||
      typeof np.block_private !== 'boolean' ||
      typeof np.block_metadata !== 'boolean'
    ) {
      return {
        error: `network policy must be 'none' or a NetworkPolicy { allowlist: string[], block_private: boolean, block_metadata: boolean, ... } (got ${JSON.stringify(opts.network).slice(0, 200)})`,
      };
    }
    networkScope = { kind: 'policy', policy: np };
  }

  if (opts.filesystem === 'none') {
    return { allowlist: [], networkScope };
  }
  const rawPaths = (opts.filesystem as { allowlist_paths?: unknown })?.allowlist_paths;
  if (!Array.isArray(rawPaths) || !rawPaths.every((p): p is string => typeof p === 'string')) {
    return {
      error: `filesystem policy must be 'none' or { allowlist_paths: string[] } (got ${JSON.stringify(opts.filesystem)})`,
    };
  }
  const resolved = normalizeAllowlistPaths(rawPaths);
  if (!Array.isArray(resolved)) {
    return { error: formatAllowlistError(resolved) };
  }
  return { allowlist: resolved, networkScope };
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
