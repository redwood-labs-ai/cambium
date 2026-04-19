/**
 * Per-allowlist-entry ext4 image + drive attachment helpers (RED-258).
 *
 * The `ExecPolicy.filesystem.allowlist_paths` field on `ExecOpts`
 * lists host directories the guest should see. This module:
 *
 *   1. Validates each path (reject traversal + rootfs collisions).
 *   2. Canonicalizes the allowlist for cache-key stability
 *      (sort by host_path; equivalent logical allowlists produce
 *      identical keys regardless of declaration order).
 *   3. Hashes the allowlist + each source directory's content
 *      signature so cache entries invalidate when the user edits
 *      the files they declared.
 *   4. Builds one ext4 image per entry via `mke2fs -d`, cached in
 *      the snapshot cache directory alongside the rootfs/memfile.
 *   5. Assigns each drive a guest-side device path
 *      (`/dev/vdb`, `/dev/vdc`, ...) based on attach order, so the
 *      agent can mount via `mount -t ext4 <device> <guest_path>`.
 *
 * Firecracker's virtio-fs device isn't supported (their device list
 * is virtio-{net,blk,balloon,vsock} + serial + keyboard, per the
 * getting-started docs). So we pay an ext4-build cost on cache
 * miss; content freshness is "whatever the host dir looked like at
 * image-build time." That tradeoff is documented in the RED-258
 * ticket + the `S - Firecracker Substrate.md` design note.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

/**
 * One logical entry in the allowlist. Today the DSL surface
 * (`ExecPolicy.filesystem.allowlist_paths`) is just `string[]`, so
 * we map each string to `{ host_path: s, guest_path: s,
 * read_only: true }` — identity mapping, read-only only. A future
 * DSL extension could surface `{ host, guest, read_only }` tuples
 * directly; this type is where that'd land without forcing callers
 * to change shape.
 */
export interface AllowlistEntry {
  /** Host-side directory to expose to the guest. */
  host_path: string;
  /** Absolute guest path where the agent mounts the drive. v1
   *  uses identity mapping (host_path === guest_path). */
  guest_path: string;
  /** v1 requires `true`; the field is here for forward-compat. */
  read_only: boolean;
}

/** Prefixes the guest's rootfs *owns entirely* — their subtrees are
 *  system-managed (binaries, kernel interfaces, config files, agent
 *  scratch) and a user mount anywhere inside would either shadow real
 *  files on startup or collide with the agent's own scratch writes.
 *  Both the prefix itself AND any subpath under it are rejected. */
const DEEP_FORBIDDEN_GUEST_PREFIXES: readonly string[] = [
  '/bin',   // guest binaries (busybox symlinks)
  '/boot',  // kernel artifacts
  '/dev',   // device nodes — including our own vda..vdy
  '/etc',   // config files (users should not shadow /etc/*)
  '/init',  // PID 1 binary
  '/lib',
  '/lib64',
  '/proc',  // kernel interface
  '/root',  // root's home — run Cambium as a non-root user
  '/run',   // runtime state
  '/sbin',  // system binaries
  '/sys',   // kernel interface
  '/tmp',   // agent writes scripts here; user-mount would shadow
  '/usr',   // read-only system data
];

/** Prefixes that exist as top-level directories in the guest rootfs
 *  but whose subtrees are *user land* by POSIX convention. Mounting
 *  exactly AT one of these shadows the whole tree (and with it any
 *  conventional layout the guest expects), but creating a fresh
 *  subdirectory like `/home/user/project/data` or `/var/app/input`
 *  under them is the common real-world case — a gen author's
 *  `~/project/data` maps cleanly through identity mapping without
 *  forcing them to first `cp` everything into a synthetic
 *  `/opt/my-gen-inputs/`. Only the exact prefix is rejected.
 *
 *  This is Cambium's opinionated stance: the substrate takes a side on
 *  what's user space vs system space rather than refusing the whole
 *  FHS top-level. If you need to mount `/etc/myapp/config`, you're in
 *  the wrong namespace — copy it to `/opt/...` or `/home/...` first. */
const EXACT_FORBIDDEN_GUEST_PREFIXES: readonly string[] = [
  '/',      // root itself — mounting at / shadows the entire rootfs
  '/home',  // whole-/home shadow; /home/user/... is allowed
  '/mnt',   // conventional mount point; /mnt/data is allowed
  '/srv',   // service data area
  '/var',   // variable data; /var/app/... is allowed
];

export type AllowlistValidationError =
  | { kind: 'not_absolute'; path: string }
  | { kind: 'has_traversal'; path: string }
  | { kind: 'rootfs_collision'; path: string; prefix: string }
  | { kind: 'not_normalized'; path: string; normalized: string }
  | { kind: 'source_missing'; path: string }
  | { kind: 'source_not_directory'; path: string }
  | { kind: 'is_symlink'; path: string }
  | { kind: 'too_many_entries'; count: number; limit: number };

/** Max allowlist entries. Bounded because virtio-blk device naming
 *  caps at 26 single-letter slots (vda..vdz); rootfs occupies vda,
 *  leaving vdb..vdy for allowlist drives. In practice, anything above
 *  ~4 is almost certainly a gen bug. */
export const MAX_ALLOWLIST_ENTRIES = 24;

/**
 * Validate one allowlist path. Paths must be absolute, normalized
 * (no `..`), not collide with rootfs-owned prefixes, and exist on
 * disk as a directory. Returns `null` on success or a structured
 * error on failure — the substrate formats the error into a clean
 * `crashed` response reason at dispatch time.
 */
export function validateAllowlistPath(path: string): AllowlistValidationError | null {
  if (!isAbsolute(path)) {
    return { kind: 'not_absolute', path };
  }
  if (path.split('/').includes('..')) {
    return { kind: 'has_traversal', path };
  }
  const norm = normalize(path);
  if (norm !== path) {
    return { kind: 'not_normalized', path, normalized: norm };
  }
  // Exact-match guards first — these are the prefixes where mounting
  // AT the prefix would shadow the whole tree, but subpaths under them
  // are the common real-world case (a gen's `/home/user/data` should
  // "just work").
  for (const prefix of EXACT_FORBIDDEN_GUEST_PREFIXES) {
    if (path === prefix) {
      return { kind: 'rootfs_collision', path, prefix };
    }
  }
  // Deep guards — the prefix OR any subpath under it is rejected.
  // These are system-owned trees where any user-side mount would
  // shadow guest binaries, config, or the agent's own scratch.
  for (const prefix of DEEP_FORBIDDEN_GUEST_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      return { kind: 'rootfs_collision', path, prefix };
    }
  }
  // Source existence check — the host dir we'd build an ext4 from.
  // Use lstatSync so a symlinked `/opt/mydata -> /etc` is rejected at
  // this layer; without this, the statSync-follows-links behavior
  // would let a gen bypass FORBIDDEN_GUEST_PREFIXES by interposing a
  // symlink outside the forbidden list pointing at something inside.
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'source_missing', path };
  }
  if (st.isSymbolicLink()) {
    return { kind: 'is_symlink', path };
  }
  if (!st.isDirectory()) {
    return { kind: 'source_not_directory', path };
  }
  return null;
}

/** Human-readable formatter for `AllowlistValidationError`. Used by
 *  the substrate when constructing the `crashed` response's reason. */
export function formatAllowlistError(e: AllowlistValidationError): string {
  switch (e.kind) {
    case 'not_absolute':
      return `allowlist path must be absolute: ${JSON.stringify(e.path)}`;
    case 'has_traversal':
      return `allowlist path must not contain ".." segments: ${JSON.stringify(e.path)}`;
    case 'not_normalized':
      return `allowlist path must be normalized (got ${JSON.stringify(e.path)}, expected ${JSON.stringify(e.normalized)})`;
    case 'rootfs_collision':
      return `allowlist path ${JSON.stringify(e.path)} collides with rootfs-owned prefix ${JSON.stringify(e.prefix)}; pick a path outside the system directories`;
    case 'source_missing':
      return `allowlist source directory does not exist on host: ${JSON.stringify(e.path)}`;
    case 'source_not_directory':
      return `allowlist source is not a directory: ${JSON.stringify(e.path)}`;
    case 'is_symlink':
      return `allowlist source must be a real directory, not a symlink: ${JSON.stringify(e.path)} (symlinks can interpose into rootfs-owned paths and bypass the prefix check)`;
    case 'too_many_entries':
      return `too many allowlist entries: ${e.count} > max ${e.limit}`;
  }
}

/**
 * Turn the DSL's `string[]` into structured `AllowlistEntry[]`.
 * v1: identity mapping, read-only. Returns the first validation
 * error encountered, or the canonicalized list on success.
 */
export function normalizeAllowlistPaths(
  paths: string[],
): AllowlistEntry[] | AllowlistValidationError {
  if (paths.length > MAX_ALLOWLIST_ENTRIES) {
    return { kind: 'too_many_entries', count: paths.length, limit: MAX_ALLOWLIST_ENTRIES };
  }
  for (const p of paths) {
    const err = validateAllowlistPath(p);
    if (err) return err;
  }
  return canonicalizeAllowlist(
    paths.map((p) => ({ host_path: p, guest_path: p, read_only: true })),
  );
}

/** Sort by host_path so same-logical-allowlist produces same cache
 *  key regardless of declaration order. Uses byte-order comparison
 *  (NOT `localeCompare`) so the ordering is deterministic across
 *  hosts — `localeCompare` without an explicit locale varies by the
 *  runtime's default locale and could produce different cache keys
 *  for the same logical allowlist when non-ASCII paths are involved. */
export function canonicalizeAllowlist(entries: AllowlistEntry[]): AllowlistEntry[] {
  return [...entries].sort((a, b) =>
    a.host_path < b.host_path ? -1 : a.host_path > b.host_path ? 1 : 0,
  );
}

/**
 * Content-identity hash for a directory tree. Walks recursively,
 * collects `(relpath, size, mtimeMs, inode)` per file, sorts, hashes.
 * Used as a stable cache-invalidation signal: any file content or
 * size or mtime change → different hash → cache entry rebuilds.
 * Does NOT hash file bytes — mtime/size/inode is a strong-enough
 * invalidation key for workspace-scale allowlists and avoids reading
 * gigabytes per cache lookup. Inode participation covers the
 * "cp replaces file with same size within one mtime quantum" corner.
 */
export function hashDirectoryTree(
  root: string,
  options?: { _maxEntries?: number },
): string {
  const maxEntries = options?._maxEntries ?? 100_000;
  const hasher = createHash('sha256');
  const entries: string[] = [];
  const walk = (dir: string, rel: string) => {
    // byte-order sort is locale-independent; localeCompare would vary
    // by host locale and could desync the cache key across machines.
    const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const item of items) {
      if (entries.length > maxEntries) {
        throw new Error(
          `allowlist source directory has more than ${maxEntries} entries; refusing to hash`,
        );
      }
      const full = join(dir, item.name);
      const relPath = rel === '' ? item.name : `${rel}/${item.name}`;
      // Defense in depth: re-check with lstatSync before recursing.
      // `Dirent.isDirectory()` returns true for symlinks that *point* at
      // a directory, so a subtree symlink like `<allowed>/link -> /etc`
      // would otherwise get walked and its contents baked into the
      // image. lstat gives us the entry's OWN type, not the target's.
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) continue; // don't follow symlinks — target data shouldn't cross the allowlist boundary
      if (lst.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!lst.isFile()) continue; // skip sockets, fifos — won't survive ext4 anyway
      entries.push(`${relPath}\0${lst.size}\0${lst.mtimeMs}\0${lst.ino}`);
    }
  };
  walk(root, '');
  for (const e of entries.sort()) {
    hasher.update(e).update('\n');
  }
  return hasher.digest('hex');
}

/**
 * Hash for the allowlist's contribution to the snapshot cache key.
 * Combines each entry's (host_path, guest_path, read_only) metadata
 * AND the current content signature of the source directory. A
 * logically-identical allowlist (same paths, same content) produces
 * the same hash; changing any file rebuilds.
 */
export function hashAllowlist(
  entries: AllowlistEntry[],
  options?: { _hashDir?: (path: string) => string },
): string {
  if (entries.length === 0) {
    // Distinct sentinel so the cache-key combine doesn't confuse
    // "no allowlist" with "missing field" on the wire.
    return 'allowlist:none';
  }
  const hashDir = options?._hashDir ?? hashDirectoryTree;
  const canonical = canonicalizeAllowlist(entries);
  const h = createHash('sha256');
  h.update('allowlist:v1\n');
  for (const e of canonical) {
    h.update(e.host_path).update('\0');
    h.update(e.guest_path).update('\0');
    h.update(e.read_only ? '1' : '0').update('\0');
    h.update(hashDir(e.host_path)).update('\n');
  }
  return h.digest('hex');
}

/**
 * One built allowlist drive, ready for Firecracker to attach.
 * `imagePath` lives in the snapshot cache directory (stable path so
 * warm-restore's baked drive config stays valid); `device` is the
 * path the guest agent will `mount -t ext4` from.
 */
export interface AllowlistDrive {
  /** Firecracker drive_id, e.g. "alw_0". Underscores not hyphens —
   *  the FC API rejects hyphens in resource IDs (alphanumeric + `_`
   *  only). The escape-test matrix surfaced this as a 400 from
   *  PUT /drives/alw-0 the first time it ran end-to-end against a
   *  real VM (preflight used `drive_id: "test"` so didn't catch it). */
  driveId: string;
  /** Host-side path to the ext4 image. Lives in the cache dir. */
  imagePath: string;
  /** Source directory on the host (informational; same as the
   *  original allowlist entry). */
  hostPath: string;
  /** Absolute guest path to mount at. Identity of host_path in v1. */
  guestPath: string;
  /** Device node inside the guest, e.g. "/dev/vdb". Computed from
   *  the drive-attach order. */
  device: string;
  /** v1 always true; forward-compat. */
  readOnly: boolean;
}

/** Turn a canonical-order allowlist index into the virtio-blk device
 *  node the guest will see. Rootfs is `/dev/vda` (allowlist-independent),
 *  so allowlist indexes start at `b`. */
export function indexToVirtioBlkDevice(index: number): string {
  if (index < 0 || index >= MAX_ALLOWLIST_ENTRIES) {
    throw new Error(
      `allowlist drive index ${index} out of range [0, ${MAX_ALLOWLIST_ENTRIES})`,
    );
  }
  // Rootfs uses /dev/vda; allowlist indexes 0..N use vdb..vdz.
  const letter = String.fromCharCode('b'.charCodeAt(0) + index);
  return `/dev/vd${letter}`;
}

/**
 * Ensure an ext4 image exists at `imagePath` containing `sourceDir`'s
 * contents. If already present, no-op (the cache dir ownership means
 * we can trust the existing file matches the cache key).
 *
 * Uses `mke2fs -t ext4 -d` — same pattern the rootfs build uses in
 * `firecracker-testbed/rootfs/ext4-builder/`. Writes to a `.tmp`
 * sibling first, then `renameSync` into place so a crash mid-build
 * can't leave a corrupt cache entry.
 */
export function ensureExt4Image(sourceDir: string, imagePath: string): void {
  if (existsSync(imagePath)) return;
  const sizeBytes = computeDirectoryContentSize(sourceDir);
  // Headroom: 30% over content + 4 MiB floor for ext4 metadata.
  // 4 MiB minimum handles "empty allowlist dir" edge case.
  const sizeMiB = Math.max(4, Math.ceil((sizeBytes * 1.3) / (1024 * 1024)) + 4);
  const tmp = `${imagePath}.tmp`;
  try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  // Create the target file at the requested size. mke2fs works on
  // a pre-sized file — we sparsify via ftruncate so the sparse
  // filesystem fills the usable part only.
  const fd = openSync(tmp, 'w');
  try {
    ftruncateSync(fd, sizeMiB * 1024 * 1024);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  const result = spawnSync(
    'mke2fs',
    ['-t', 'ext4', '-d', sourceDir, '-F', tmp],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    const msg = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`;
    throw new Error(
      `mke2fs failed for ${sourceDir} -> ${imagePath}: ${msg}`,
    );
  }
  renameSync(tmp, imagePath);
  chmodSync(imagePath, 0o600);
}

function computeDirectoryContentSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      // Same symlink-skip rationale as hashDirectoryTree — if we ever
      // size a symlink-followed directory, mke2fs would also include
      // it, expanding the image to cover forbidden host content.
      const lst = lstatSync(p);
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        walk(p);
      } else if (lst.isFile()) {
        total += lst.size;
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * Build ext4 images for every entry in the allowlist (if not already
 * cached) and return the full list of drives ready to attach to a
 * fresh Firecracker VM. Image paths live in `cacheDir` next to the
 * snapshot's rootfs/memfile — stable location so warm-restore's
 * baked drive config stays valid.
 */
export function buildAllowlistDrives(
  entries: AllowlistEntry[],
  cacheDir: string,
): AllowlistDrive[] {
  const canonical = canonicalizeAllowlist(entries);
  const drives: AllowlistDrive[] = [];
  for (let i = 0; i < canonical.length; i++) {
    const e = canonical[i];
    const imagePath = join(cacheDir, `allowlist-${i}.ext4`);
    ensureExt4Image(e.host_path, imagePath);
    drives.push({
      driveId: `alw_${i}`,
      imagePath,
      hostPath: e.host_path,
      guestPath: e.guest_path,
      device: indexToVirtioBlkDevice(i),
      readOnly: e.read_only,
    });
  }
  return drives;
}

/** Shape the agent expects over the wire — matches `Mount` in
 *  `crates/cambium-agent/src/protocol.rs`. Kept here rather than in
 *  a shared types file because it's the substrate's private
 *  agent-protocol contract. */
export interface AgentMount {
  device: string;
  guest_path: string;
  read_only: boolean;
}

/** Drop the host-only fields and surface just what the agent needs.
 *  Used at ExecRequest construction time. */
export function drivesToAgentMounts(drives: AllowlistDrive[]): AgentMount[] {
  return drives.map((d) => ({
    device: d.device,
    guest_path: d.guestPath,
    read_only: d.readOnly,
  }));
}
