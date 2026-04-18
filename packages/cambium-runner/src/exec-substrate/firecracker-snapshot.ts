/**
 * Snapshot/restore for the `:firecracker` substrate (RED-256).
 *
 * Swaps the cold-boot-per-call path for a memfile+snapshotfile restore
 * when the content-addressed cache has an entry for the `(rootfs,
 * kernel, canonical machine-config)` tuple. On cache miss, the cold-
 * boot path runs and saves a snapshot inline so the next call hits.
 *
 * Design decisions are pinned in the ticket:
 *   - Shared-mmap (`mem_backend: { backend_type: "File" }`) restore —
 *     what Firecracker ships specifically for per-call VM fleets. The
 *     ext4-copy alternative would eat the latency win on the most
 *     common production filesystem.
 *   - Canonical machine-config only. Non-canonical (cpu/memory)
 *     sizing cold-boots and records a fallback reason in the trace.
 *   - Workspace-local cache under `packages/cambium-runner/var/
 *     snapshots/<cacheKey>/`. Directory 0700, files 0600.
 *   - First-miss snapshot creation is inline on the calling request.
 *     The first call in a fresh workspace pays cold-boot +
 *     snapshot-create; every subsequent call hits the cache.
 *   - In-process digest cache keyed by `(path, size, mtime)` so
 *     hashing a 100MB+ rootfs doesn't happen on every dispatch.
 *
 * Answered by the RED-256 snapshot-spike on the MS-R1:
 *   p95 3.4ms `/vm Resumed` → first-dial CONNECT-OK across 100 runs
 *   (direct-dial after resume is viable; no retry needed).
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  dialAndHandshake,
  VSOCK_GUEST_PORT,
  type BufferedSocketLike,
} from './firecracker-protocol.js';
import {
  apiPatchExpect204,
  apiPutExpect204,
  apiPutRaw,
  killFirecracker,
  makeLogAccumulator,
  spawnFirecracker,
  waitForApiSocket,
  type LogAccumulator,
} from './firecracker-api.js';

/** The single canonical machine-config shape. Any ExecOpts that
 *  differ from this (after the `Math.max(1, Math.round(...))`
 *  normalization the substrate applies) bypasses the snapshot path
 *  and cold-boots. The cache is NOT a `(cpu, memory)` matrix —
 *  users who need larger VMs pay the cold-boot cost. */
export const CANONICAL_VCPU = 1;
export const CANONICAL_MEM_MIB = 512;

/** The agent is PID 1 inside the guest (RED-255). Same path the
 *  cold-boot substrate uses in `init=`; keep in sync. */
const AGENT_INIT_PATH = '/usr/local/bin/cambium-agent';
const GUEST_CID = 3;

/** How long to wait for the agent to bind its vsock listener during
 *  a template build. Longer than the normal dial-deadline because
 *  this is a real cold-boot. */
const TEMPLATE_BOOT_DEADLINE_MS = 20_000;
/** How long to wait for the restored VM's first accept-wake. Based
 *  on RED-256 spike p95 of 3.4 ms; 5s gives headroom 1000x over. */
const RESTORE_DEADLINE_MS = 5_000;

export type FallbackReason =
  | 'non_canonical_sizing'
  | 'missing'
  | 'load_failed'
  | 'shared_mem_unsupported'
  | 'build_locked';

/**
 * Check whether the ExecOpts match canonical sizing AFTER the
 * normalization the substrate applies (matching `Math.max(1,
 * Math.round(opts.cpu))` etc. in firecracker.ts). The substrate
 * uses this BEFORE calling `lookupOrCreateSnapshot`; if it returns
 * false, the substrate cold-boots with a `non_canonical_sizing`
 * fallback reason.
 */
export function isCanonicalSizing(opts: { cpu: number; memory: number }): boolean {
  const vcpu = Math.max(1, Math.round(opts.cpu));
  const mem = Math.max(16, Math.round(opts.memory));
  return vcpu === CANONICAL_VCPU && mem === CANONICAL_MEM_MIB;
}

/**
 * Content-addressed cache key for `(rootfs, kernel, canonical
 * machine-config)`. SHA-256(rootfs) concatenated with SHA-256(kernel),
 * concatenated with SHA-256(JSON-canonicalized machine-config), then
 * re-hashed and the first 16 hex chars used. Short enough to be a
 * readable directory name, long enough that accidental collisions
 * are negligible. Re-hashing with concat rather than joining strings
 * is to defend against any length-extension-ish confusion; 16 hex
 * chars = 64 bits of randomness, which is plenty for a local cache.
 */
export async function computeCacheKey(
  rootfsPath: string,
  kernelPath: string,
  options?: { _hashFile?: (path: string) => Promise<string> },
): Promise<string> {
  const hashFile = options?._hashFile ?? hashFileWithCache;
  const rootfsHash = await hashFile(rootfsPath);
  const kernelHash = await hashFile(kernelPath);
  const configHash = createHash('sha256')
    .update(JSON.stringify({ vcpu: CANONICAL_VCPU, mem_mib: CANONICAL_MEM_MIB }))
    .digest('hex');
  const combined = createHash('sha256')
    .update(rootfsHash)
    .update(kernelHash)
    .update(configHash)
    .digest('hex');
  return combined.slice(0, 16);
}

// In-process digest cache — SHA-256 of a 100+ MB rootfs would be
// ~0.5–1s on first call; we can't eat that on every dispatch.
// Keyed by `(path, size, mtime_ms)` so any change invalidates.
const _digestCache = new Map<string, string>();

function digestCacheKey(path: string): string {
  const st = statSync(path);
  // Include `st.ino` so that an in-place replacement (`cp new old` with
  // the same resulting size, where the replacement writes within a
  // single filesystem-mtime quantum) invalidates the cache. Inode
  // changes on rename / cp / most replacement operations; pairing it
  // with size + mtimeMs closes the same-size-same-millisecond alias
  // that the reviewer flagged. Defense in depth — the concrete alias
  // is rare, but the cost is one integer in the key.
  return `${path}::${st.ino}::${st.size}::${st.mtimeMs}`;
}

async function hashFileWithCache(path: string): Promise<string> {
  const key = digestCacheKey(path);
  const hit = _digestCache.get(key);
  if (hit) return hit;
  const hash = await hashFile(path);
  _digestCache.set(key, hash);
  return hash;
}

/** Compute SHA-256 of a file in fixed-size chunks. Synchronous I/O
 *  via `openSync` / `readSync` is fine here — we're doing this once
 *  per unique rootfs/kernel, not per call. */
async function hashFile(path: string): Promise<string> {
  const hasher = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      hasher.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    try { (await import('node:fs')).closeSync(fd); } catch { /* best-effort */ }
  }
  return hasher.digest('hex');
}

/** Test hook: wipe the in-process digest cache. */
export function _resetDigestCacheForTests(): void {
  _digestCache.clear();
}

/**
 * Default root for the snapshot cache. Mirrors the path the ticket
 * pinned: `packages/cambium-runner/var/snapshots/`. Resolved relative
 * to this module's location so the cache lives next to the runner's
 * source tree regardless of where the runner is invoked from.
 */
export function defaultCacheRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // `exec-substrate/` → `src/` → `cambium-runner/` → `var/snapshots/`
  return join(here, '..', '..', 'var', 'snapshots');
}

export interface SnapshotHandle {
  /** Directory containing `mem.img` + `snapshot.bin` + `rootfs.ext4`
   *  for this cache entry. Created lazily on cache-miss. */
  dir: string;
  memFile: string;
  snapshotFile: string;
  /** The template's baked drive path. Lives in the cache directory
   *  (not a per-call tempdir) so warm restores can reopen it — the
   *  snapshot file records this path, and on restore Firecracker
   *  expects the same path to still exist. Using `/tmp/cambium-fc-
   *  XXX/rootfs.ext4` at template-build time and then cleaning up
   *  the tempdir in the finally-block would leave every subsequent
   *  warm restore trying to open a nonexistent drive. */
  rootfsFile: string;
  /** Exclusive-access lockfile path. Both `executeColdAndSave` and
   *  `executeWarm` acquire this before doing anything to the cache
   *  entry. Serializes per-cache-entry access so concurrent callers
   *  don't race on writing `rootfsFile` (which is mounted writable
   *  inside the guest; two parallel warm restores would otherwise
   *  have their guest-side writes to `/tmp/script.js` stomp on each
   *  other — a correctness-and-data-isolation issue, not just
   *  quality). Contention is resolved by the non-holder falling
   *  back to cold-only rather than blocking. */
  lockFile: string;
  cacheKey: string;
}

/** Compute the SnapshotHandle for a (rootfs, kernel) pair without
 *  checking whether the files exist on disk. */
export async function handleFor(
  rootfsPath: string,
  kernelPath: string,
  cacheRoot: string,
  options?: { _hashFile?: (path: string) => Promise<string> },
): Promise<SnapshotHandle> {
  const cacheKey = await computeCacheKey(rootfsPath, kernelPath, options);
  const dir = join(cacheRoot, cacheKey);
  return {
    dir,
    memFile: join(dir, 'mem.img'),
    snapshotFile: join(dir, 'snapshot.bin'),
    rootfsFile: join(dir, 'rootfs.ext4'),
    lockFile: join(dir, '.lock'),
    cacheKey,
  };
}

/**
 * Validate an operator-supplied cache root (env var) before using
 * it as the parent of per-cache-entry subdirectories. Returns the
 * canonicalized absolute path, or an error message suitable for
 * surfacing from `available()`.
 *
 * The subsequent `join(cacheRoot, cacheKey)` would otherwise accept
 * a relative `..`-bearing env value and land snapshot files (100+
 * MB memory images) outside the intended tree. Path traversal via
 * operator env isn't a direct exploit — it's a misconfiguration
 * foot-gun — but the fix is one line, same pattern as `memory/keys`
 * under RED-215.
 */
export function resolveCacheRoot(envValue: string | undefined): string | { error: string } {
  if (!envValue) return defaultCacheRoot();
  if (!isAbsolute(envValue)) {
    return {
      error: `${envValue} must be an absolute path. Snapshots persist across runs; a relative path would resolve differently depending on CWD.`,
    };
  }
  if (envValue.includes('\0')) {
    return { error: `contains null byte` };
  }
  const normalized = normalize(envValue);
  if (normalized !== envValue) {
    return {
      error: `${envValue} is not normalized (contains "." or ".." segments). Supply the canonical path directly: ${normalized}`,
    };
  }
  return normalized;
}

/**
 * Exclusive lock on a cache entry. Uses `O_CREAT | O_EXCL` semantics
 * so the check-and-acquire is atomic at the filesystem level. The
 * holder writes its PID to the lockfile for diagnostic output; the
 * non-holder gets a null and is expected to fall back to cold-only
 * (no save) rather than wait — minimizes head-of-line blocking and
 * keeps latency predictable.
 */
export function tryAcquireCacheLock(handle: SnapshotHandle): number | null {
  // ensureCacheDir created the parent; lockfile goes alongside the
  // snapshot files.
  try {
    const fd = openSync(
      handle.lockFile,
      // O_CREAT | O_EXCL | O_WRONLY — create new, fail if exists, writable.
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeSync(fd, Buffer.from(`${process.pid}\n`));
    return fd;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return null;
    throw e;
  }
}

/** Release a previously acquired cache lock. No-op if `fd` is null. */
export function releaseCacheLock(handle: SnapshotHandle, fd: number | null): void {
  if (fd === null) return;
  try { closeSync(fd); } catch { /* ignore */ }
  try { rmSync(handle.lockFile, { force: true }); } catch { /* ignore */ }
}

/** True iff the cache directory has both files present. */
export function snapshotExists(handle: SnapshotHandle): boolean {
  return existsSync(handle.memFile) && existsSync(handle.snapshotFile);
}

/** Ensure the cache directory exists with the expected permissions.
 *  Files inside inherit a 0600 chmod at creation time (the snapshot
 *  API writes them; we chmod afterwards as defense-in-depth). */
export function ensureCacheDir(handle: SnapshotHandle): void {
  mkdirSync(handle.dir, { recursive: true, mode: 0o700 });
  // mkdir's mode arg is umask-affected; re-chmod to make the perms
  // explicit regardless of the runner user's umask.
  chmodSync(handle.dir, 0o700);
}

/** After Firecracker writes the memfile and snapshotfile via
 *  /snapshot/create, pin them to 0600 and verify both exist. */
export function finalizeSnapshotFiles(handle: SnapshotHandle): void {
  if (!existsSync(handle.memFile) || !existsSync(handle.snapshotFile)) {
    throw new Error(
      `snapshot files not produced at ${handle.dir} (memFile or snapshotFile missing)`,
    );
  }
  chmodSync(handle.memFile, 0o600);
  chmodSync(handle.snapshotFile, 0o600);
}

/** Create a snapshot from a live, paused VM. The caller is
 *  responsible for pausing the VM first via PATCH /vm Paused. */
export async function createSnapshot(
  apiSock: string,
  handle: SnapshotHandle,
): Promise<void> {
  ensureCacheDir(handle);
  // Write to temp paths first; rename into place only after success
  // so a crash mid-snapshot doesn't leave a corrupt cache entry.
  const tmpMem = `${handle.memFile}.tmp`;
  const tmpSnap = `${handle.snapshotFile}.tmp`;
  try { rmSync(tmpMem, { force: true }); } catch {}
  try { rmSync(tmpSnap, { force: true }); } catch {}
  await apiPutExpect204(apiSock, '/snapshot/create', {
    snapshot_path: tmpSnap,
    mem_file_path: tmpMem,
    snapshot_type: 'Full',
  });
  renameSync(tmpMem, handle.memFile);
  renameSync(tmpSnap, handle.snapshotFile);
  finalizeSnapshotFiles(handle);
}

export interface RestoreResult {
  fc: ChildProcess;
  sock: BufferedSocketLike;
  restoreMs: number;
}

/**
 * Restore a VM from a snapshot handle. Spawns firecracker, loads
 * the snapshot with the shared-mmap File backend, resumes, dials
 * the parent UDS, completes the CONNECT handshake, returns the
 * live socket. Caller takes ownership of killing `fc` and
 * destroying `sock` when done.
 *
 * Throws on any API failure — the caller catches and falls back
 * to cold-boot with the appropriate `FallbackReason`.
 */
export async function restoreFromSnapshot(
  handle: SnapshotHandle,
  apiSock: string,
  vsockUds: string,
  log: LogAccumulator,
): Promise<RestoreResult> {
  const fc = spawnFirecracker(apiSock, log);
  await waitForApiSocket(apiSock, 5_000);

  const t0 = Date.now();
  // Shared-mmap File backend — the mode Firecracker ships for
  // per-call VM fleets. Multiple concurrent restores mmap the
  // memfile read-only; the kernel does per-VM CoW on writes.
  const loadResp = await apiPutRaw(apiSock, '/snapshot/load', {
    snapshot_path: handle.snapshotFile,
    mem_backend: {
      backend_type: 'File',
      backend_path: handle.memFile,
    },
    enable_diff_snapshots: false,
    resume_vm: false,
  });
  if (loadResp.statusCode !== 204) {
    killFirecracker(fc);
    const err = new Error(
      `Firecracker /snapshot/load returned ${loadResp.statusCode}: ${loadResp.body}`,
    );
    (err as any).code = 'SNAPSHOT_LOAD_FAILED';
    throw err;
  }

  // Resume, then immediately dial. RED-256 spike proved guest
  // accept() wakes at p95 3.4 ms, well under the 5s deadline.
  await apiPatchExpect204(apiSock, '/vm', { state: 'Resumed' });

  let sock: BufferedSocketLike;
  try {
    const dialed = await dialAndHandshake(
      vsockUds,
      VSOCK_GUEST_PORT,
      Date.now() + RESTORE_DEADLINE_MS,
    );
    sock = dialed.sock;
  } catch (e) {
    killFirecracker(fc);
    throw e;
  }
  const restoreMs = Date.now() - t0;
  return { fc, sock, restoreMs };
}

/**
 * Build a template snapshot inline during a cold-boot. Assumes the
 * caller has already spawned firecracker, driven it through
 * machine-config / boot-source / drives / vsock / InstanceStart,
 * and dialed + handshaked so the agent is confirmed in accept().
 * This function:
 *
 *   1. Pauses the VM (PATCH /vm Paused).
 *   2. Creates the snapshot (PUT /snapshot/create) into the cache dir.
 *   3. Resumes the VM (PATCH /vm Resumed) so the caller can continue
 *      with the user's ExecRequest against the same running VM.
 *
 * Returns the elapsed ms for the create step (NOT including pause /
 * resume — those are effectively free). The caller uses this for the
 * `ExecSnapshotLoaded` trace event's `createMs` metadata.
 */
export async function saveTemplateInline(
  apiSock: string,
  handle: SnapshotHandle,
): Promise<number> {
  const t0 = Date.now();
  await apiPatchExpect204(apiSock, '/vm', { state: 'Paused' });
  await createSnapshot(apiSock, handle);
  const ms = Date.now() - t0;
  await apiPatchExpect204(apiSock, '/vm', { state: 'Resumed' });
  return ms;
}

// Re-export canonical values so the substrate can PUT exactly what
// the cache was keyed on, without importing both modules for just
// constants.
export const CANONICAL_MACHINE_CONFIG = Object.freeze({
  vcpu_count: CANONICAL_VCPU,
  mem_size_mib: CANONICAL_MEM_MIB,
});

export { AGENT_INIT_PATH, GUEST_CID };
