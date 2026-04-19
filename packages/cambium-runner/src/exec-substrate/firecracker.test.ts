import { describe, it, expect } from 'vitest';
import { FirecrackerSubstrate } from './firecracker.js';

/**
 * Unit tests for the `:firecracker` substrate — policy-scope checks +
 * environment gating. Full end-to-end boot + vsock round-trip lives in
 * the testbed (`firecracker-testbed/smoke.sh`), not here; the gated
 * environment (Linux+KVM+Firecracker+artifacts) isn't the common dev
 * setup. These tests cover the logic paths that CAN run anywhere.
 */

describe('FirecrackerSubstrate.available', () => {
  it('returns a platform-explicit reason on non-Linux hosts', () => {
    // Running this suite on Linux would bypass the check; the test
    // name makes that tradeoff explicit.
    if (process.platform === 'linux') return;
    const sub = new FirecrackerSubstrate();
    const reason = sub.available();
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/Linux \+ KVM/);
    expect(reason).toMatch(process.platform);
  });
});

describe('FirecrackerSubstrate.execute — scope gates', () => {
  const baseOpts = {
    language: 'js' as const,
    code: 'console.log(1)',
    cpu: 1,
    memory: 128,
    timeout: 5,
    maxOutputBytes: 50_000,
    network: 'none' as const,
    filesystem: 'none' as const,
  };

  it('rejects a non-"none" network policy with a pointer to the follow-up path', async () => {
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      network: {
        allowlist: ['api.example.com'],
        denylist: [],
        block_private: true,
        block_metadata: true,
      },
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/network: 'none' only/);
    expect(result.reason).toMatch(/allowlist/);
  });

  it('rejects an allowlist path that collides with a rootfs-owned prefix', async () => {
    // RED-258: filesystem allowlist is now supported (via virtio-blk
    // ext4 images), but paths that would collide with the rootfs's
    // own directories are rejected at policy-check time — mounting
    // over /var / /etc / /bin etc. would break the guest.
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      filesystem: { allowlist_paths: ['/var/data'] },
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/rootfs-owned prefix/);
    expect(result.reason).toMatch(/\/var\/data/);
  });

  it('rejects a relative allowlist path', async () => {
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      filesystem: { allowlist_paths: ['relative/dir'] },
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/must be absolute/);
  });

  it('rejects an allowlist path with traversal segments', async () => {
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      filesystem: { allowlist_paths: ['/data/../etc'] },
    });
    expect(result.status).toBe('crashed');
    // Either the traversal check fires first or the normalization
    // check does — both are correct outcomes. Accept either.
    expect(result.reason).toMatch(/\.\.|normalized/);
  });

  it('rejects an allowlist pointing at a non-existent host directory', async () => {
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      filesystem: { allowlist_paths: ['/opt/definitely-not-here-cambium-test-xyz-42'] },
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/does not exist on host/);
  });

  it('fails closed on a malformed filesystem shape (no allowlist_paths) without leaking a TypeError', async () => {
    // Models a bad IR that got past the TS type checker via `as any`:
    // filesystem is an object but missing the expected allowlist_paths
    // field. The gate should still refuse cleanly and return a
    // status:'crashed' with a clean error — NOT a raw stack trace
    // from `undefined.join(...)` or similar.
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute({
      ...baseOpts,
      filesystem: {} as any,
    });
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/filesystem policy must be 'none' or/);
    expect(result.reason).not.toMatch(/TypeError/);
    expect(result.reason).not.toMatch(/Cannot read properties/);
  });

  it('surfaces the available() reason when the substrate is unavailable', async () => {
    // On non-Linux hosts this is the default path — available() returns
    // a platform error, and execute() should surface it as status:
    // 'crashed' WITHOUT trying to spawn firecracker.
    if (process.platform === 'linux') return;
    const sub = new FirecrackerSubstrate();
    const result = await sub.execute(baseOpts);
    expect(result.status).toBe('crashed');
    expect(result.reason).toMatch(/Linux \+ KVM/);
    // Scope checks run before availability, so this test also confirms
    // that `network: 'none' + filesystem: 'none'` passes the scope gate
    // and lets availability be the failing path.
  });
});
