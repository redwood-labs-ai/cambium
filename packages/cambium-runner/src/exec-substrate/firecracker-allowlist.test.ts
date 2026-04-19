import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: we cannot use `os.tmpdir()` as the scratch base: on macOS it
// lives under `/var/folders/...`, which collides with the rootfs-owned
// `/var` prefix and fails the validator before we get to the assertion
// we actually want to make. Place the scratch dir under the repo root
// instead, which is outside every FORBIDDEN_GUEST_PREFIXES entry.
const SCRATCH_BASE = process.cwd();
import {
  MAX_ALLOWLIST_ENTRIES,
  validateAllowlistPath,
  normalizeAllowlistPaths,
  canonicalizeAllowlist,
  hashAllowlist,
  hashDirectoryTree,
  indexToVirtioBlkDevice,
  drivesToAgentMounts,
  formatAllowlistError,
  type AllowlistDrive,
} from './firecracker-allowlist.js';

/**
 * Unit tests for the pure-TS allowlist helpers (RED-258). The
 * `mke2fs`-spawning paths (`ensureExt4Image`, `buildAllowlistDrives`)
 * are Linux-only and covered end-to-end by the escape-test matrix
 * under `firecracker-testbed/`. These tests exercise only the logic
 * reachable without a real block device.
 */

describe('validateAllowlistPath', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(SCRATCH_BASE, '.cambium-test-cambium-allowlist-test-'));
    mkdirSync(join(scratch, 'dir'), { recursive: true });
    writeFileSync(join(scratch, 'file.txt'), 'hi');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('accepts an absolute, normalized directory that exists', () => {
    expect(validateAllowlistPath(join(scratch, 'dir'))).toBeNull();
  });

  it('rejects a relative path', () => {
    const e = validateAllowlistPath('relative/path');
    expect(e?.kind).toBe('not_absolute');
  });

  it('rejects a traversal segment', () => {
    const e = validateAllowlistPath('/data/../etc');
    expect(e?.kind).toBe('has_traversal');
  });

  it('rejects a deep-forbidden prefix at the prefix itself', () => {
    const e = validateAllowlistPath('/etc');
    expect(e?.kind).toBe('rootfs_collision');
    if (e?.kind === 'rootfs_collision') expect(e.prefix).toBe('/etc');
  });

  it('rejects a deep-forbidden prefix subpath', () => {
    // /etc is system-owned; /etc/myapp would shadow a potentially
    // existing config.
    const e = validateAllowlistPath('/etc/myapp');
    expect(e?.kind).toBe('rootfs_collision');
    if (e?.kind === 'rootfs_collision') expect(e.prefix).toBe('/etc');
  });

  it('rejects exact mount at an EXACT_FORBIDDEN user-land prefix', () => {
    // /var itself shadows the whole /var tree (logs, lib, ...).
    const e = validateAllowlistPath('/var');
    expect(e?.kind).toBe('rootfs_collision');
    if (e?.kind === 'rootfs_collision') expect(e.prefix).toBe('/var');
  });

  it('accepts deep subpaths under an EXACT_FORBIDDEN user-land prefix (Cambium opinion)', () => {
    // /var/data should not be rejected by prefix — it may fail with
    // source_missing if the dir doesn't exist, but the prefix gate
    // passes. This is the Rails-style opinion: user-land FHS
    // directories are open to deep use.
    const e = validateAllowlistPath('/var/data');
    // Either source_missing (dir doesn't exist) OR source_not_directory.
    // What we're asserting: NOT rootfs_collision.
    expect(e?.kind).not.toBe('rootfs_collision');
  });

  it('accepts deep subpaths under /home (user home directories)', () => {
    const e = validateAllowlistPath('/home/someone/project/data');
    expect(e?.kind).not.toBe('rootfs_collision');
  });

  it('rejects root itself', () => {
    const e = validateAllowlistPath('/');
    expect(e?.kind).toBe('rootfs_collision');
  });

  it('rejects a missing host directory', () => {
    const e = validateAllowlistPath('/opt/cambium-definitely-not-here-xyz');
    expect(e?.kind).toBe('source_missing');
  });

  it('rejects a path that points at a file, not a directory', () => {
    const e = validateAllowlistPath(join(scratch, 'file.txt'));
    expect(e?.kind).toBe('source_not_directory');
  });

  it('rejects a symlinked directory (defense against FORBIDDEN_GUEST_PREFIXES bypass)', () => {
    // Create a symlink under scratch that points at `dir`. Even though
    // the resolved target is a real directory, the symlink itself is
    // rejected. This is the guard against a gen declaring
    // `/opt/mydata` where `/opt/mydata` is a symlink to `/etc`: the
    // top-level prefix check passes, but `lstatSync` catches the
    // symlink and refuses.
    const link = join(scratch, 'dir-symlink');
    symlinkSync(join(scratch, 'dir'), link);
    const e = validateAllowlistPath(link);
    expect(e?.kind).toBe('is_symlink');
  });
});

describe('normalizeAllowlistPaths', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(SCRATCH_BASE, '.cambium-test-cambium-allowlist-norm-'));
    mkdirSync(join(scratch, 'a'), { recursive: true });
    mkdirSync(join(scratch, 'b'), { recursive: true });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns canonicalized entries on success', () => {
    const result = normalizeAllowlistPaths([
      join(scratch, 'b'),
      join(scratch, 'a'),
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.map((e) => e.host_path)).toEqual([
        join(scratch, 'a'),
        join(scratch, 'b'),
      ]);
      expect(result.every((e) => e.read_only === true)).toBe(true);
      expect(result.every((e) => e.host_path === e.guest_path)).toBe(true);
    }
  });

  it('bubbles up the first validation error', () => {
    const result = normalizeAllowlistPaths([join(scratch, 'a'), '/etc']);
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) expect(result.kind).toBe('rootfs_collision');
  });

  it('rejects above MAX_ALLOWLIST_ENTRIES', () => {
    const many = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => `/opt/p${i}`);
    const result = normalizeAllowlistPaths(many);
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) expect(result.kind).toBe('too_many_entries');
  });
});

describe('hashAllowlist', () => {
  it('returns the "none" sentinel on empty input', () => {
    expect(hashAllowlist([])).toBe('allowlist:none');
  });

  it('is order-independent (canonicalizes first)', () => {
    const fakeHash = () => 'deadbeef';
    const a = hashAllowlist(
      [
        { host_path: '/a', guest_path: '/a', read_only: true },
        { host_path: '/b', guest_path: '/b', read_only: true },
      ],
      { _hashDir: fakeHash },
    );
    const b = hashAllowlist(
      [
        { host_path: '/b', guest_path: '/b', read_only: true },
        { host_path: '/a', guest_path: '/a', read_only: true },
      ],
      { _hashDir: fakeHash },
    );
    expect(a).toBe(b);
  });

  it('changes when a source directory hash changes', () => {
    const entries = [{ host_path: '/x', guest_path: '/x', read_only: true }];
    const h1 = hashAllowlist(entries, { _hashDir: () => 'v1' });
    const h2 = hashAllowlist(entries, { _hashDir: () => 'v2' });
    expect(h1).not.toBe(h2);
  });

  it('distinguishes read_only from read-write', () => {
    const ro = hashAllowlist(
      [{ host_path: '/x', guest_path: '/x', read_only: true }],
      { _hashDir: () => 'same' },
    );
    const rw = hashAllowlist(
      [{ host_path: '/x', guest_path: '/x', read_only: false }],
      { _hashDir: () => 'same' },
    );
    expect(ro).not.toBe(rw);
  });

  it('distinguishes distinct guest_path for same host_path', () => {
    const a = hashAllowlist(
      [{ host_path: '/x', guest_path: '/mounted/a', read_only: true }],
      { _hashDir: () => 'same' },
    );
    const b = hashAllowlist(
      [{ host_path: '/x', guest_path: '/mounted/b', read_only: true }],
      { _hashDir: () => 'same' },
    );
    expect(a).not.toBe(b);
  });
});

describe('hashDirectoryTree — symlink handling', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(SCRATCH_BASE, '.cambium-test-symlinks-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('does not follow symlinks, so symlink targets cannot contribute to the hash', () => {
    // Two source trees:
    //   A: just a regular file
    //   B: same regular file + a symlink pointing at an *entirely
    //      separate* dir whose contents would change the hash if we
    //      followed links
    // Hashes must be identical — the symlink contributes nothing.
    const a = join(scratch, 'tree-a');
    const b = join(scratch, 'tree-b');
    const external = join(scratch, 'external');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(a, 'readme.txt'), 'hello');
    writeFileSync(join(b, 'readme.txt'), 'hello');
    writeFileSync(join(external, 'sensitive.txt'), 'PRETEND-THIS-IS-/etc/passwd');
    symlinkSync(external, join(b, 'link-to-external'));

    // mtime-based equality can be flaky if `readme.txt` writes take
    // different nanoseconds on each side. We assert the hashes differ
    // ONLY in a way that reflects the files walked, not the symlink
    // target. A strict equality check over mtimeMs would be brittle,
    // so we re-hash both trees and accept them as either equal (if
    // both files got the same mtime) or non-equal. What we DO assert
    // is that appending MORE files under `external` has no effect on
    // b's hash — which is the security-relevant invariant.
    const bEmptyExternal = hashDirectoryTree(b);
    writeFileSync(join(external, 'more.txt'), 'MORE-SENSITIVE-DATA');
    const bAfterExternalGrow = hashDirectoryTree(b);
    expect(bEmptyExternal).toBe(bAfterExternalGrow);
  });
});

describe('canonicalizeAllowlist', () => {
  it('sorts by host_path without mutating the input', () => {
    const input = [
      { host_path: '/c', guest_path: '/c', read_only: true },
      { host_path: '/a', guest_path: '/a', read_only: true },
      { host_path: '/b', guest_path: '/b', read_only: true },
    ];
    const snap = [...input];
    const sorted = canonicalizeAllowlist(input);
    expect(sorted.map((e) => e.host_path)).toEqual(['/a', '/b', '/c']);
    expect(input).toEqual(snap);
  });
});

describe('indexToVirtioBlkDevice', () => {
  it('maps 0 to /dev/vdb (rootfs is /dev/vda)', () => {
    expect(indexToVirtioBlkDevice(0)).toBe('/dev/vdb');
  });

  it('maps MAX-1 to /dev/vdy (vda is rootfs, so 24 allowlist slots run vdb..vdy)', () => {
    expect(indexToVirtioBlkDevice(MAX_ALLOWLIST_ENTRIES - 1)).toBe('/dev/vdy');
  });

  it('throws on negative index', () => {
    expect(() => indexToVirtioBlkDevice(-1)).toThrow(/out of range/);
  });

  it('throws at or above MAX', () => {
    expect(() => indexToVirtioBlkDevice(MAX_ALLOWLIST_ENTRIES)).toThrow(/out of range/);
  });
});

describe('drivesToAgentMounts', () => {
  it('strips host-only fields, keeps device/guest_path/read_only', () => {
    const drives: AllowlistDrive[] = [
      {
        driveId: 'alw_0',
        imagePath: '/cache/allowlist-0.ext4',
        hostPath: '/host/data',
        guestPath: '/guest/data',
        device: '/dev/vdb',
        readOnly: true,
      },
    ];
    expect(drivesToAgentMounts(drives)).toEqual([
      { device: '/dev/vdb', guest_path: '/guest/data', read_only: true },
    ]);
  });
});

describe('formatAllowlistError', () => {
  it('renders each error kind with the offending path', () => {
    expect(formatAllowlistError({ kind: 'not_absolute', path: 'rel' })).toMatch(/absolute/);
    expect(
      formatAllowlistError({ kind: 'rootfs_collision', path: '/etc/x', prefix: '/etc' }),
    ).toMatch(/rootfs-owned/);
    expect(formatAllowlistError({ kind: 'source_missing', path: '/nope' })).toMatch(/does not exist/);
    expect(
      formatAllowlistError({ kind: 'too_many_entries', count: 99, limit: 24 }),
    ).toMatch(/too many/);
  });
});
