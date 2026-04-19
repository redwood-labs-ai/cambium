import { describe, it, expect } from 'vitest';
import { resolveAllowlist, ipIsPrivateV4 } from './firecracker-dns.js';
import type { NetworkPolicy } from '../tools/permissions.js';

const BASE_POLICY: NetworkPolicy = {
  allowlist: [],
  denylist: [],
  block_private: false,
  block_metadata: false,
};

/** Fake resolver — tests inject this so they don't hit real DNS. */
function resolverFrom(map: Record<string, string[]>) {
  return async (name: string): Promise<string[]> => {
    const ips = map[name];
    if (!ips) {
      const err: NodeJS.ErrnoException = new Error(`ENOTFOUND ${name}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return ips;
  };
}

describe('ipIsPrivateV4', () => {
  it('classifies 10.0.0.0/8', () => {
    expect(ipIsPrivateV4('10.0.0.1')).toBe(true);
    expect(ipIsPrivateV4('10.255.255.255')).toBe(true);
  });

  it('classifies 172.16.0.0/12 and boundary', () => {
    expect(ipIsPrivateV4('172.16.0.1')).toBe(true);
    expect(ipIsPrivateV4('172.31.255.254')).toBe(true);
    // Just outside — 172.15 and 172.32 are NOT in the /12 range.
    expect(ipIsPrivateV4('172.15.0.1')).toBe(false);
    expect(ipIsPrivateV4('172.32.0.1')).toBe(false);
  });

  it('classifies 192.168.0.0/16', () => {
    expect(ipIsPrivateV4('192.168.1.1')).toBe(true);
  });

  it('classifies loopback 127.0.0.0/8', () => {
    expect(ipIsPrivateV4('127.0.0.1')).toBe(true);
  });

  it('classifies link-local 169.254.0.0/16 (includes metadata IP)', () => {
    expect(ipIsPrivateV4('169.254.169.254')).toBe(true);
    expect(ipIsPrivateV4('169.254.1.1')).toBe(true);
  });

  it('rejects public IPs', () => {
    expect(ipIsPrivateV4('1.1.1.1')).toBe(false);
    expect(ipIsPrivateV4('8.8.8.8')).toBe(false);
    expect(ipIsPrivateV4('140.82.112.6')).toBe(false);
  });

  it('returns false for non-v4 inputs', () => {
    // v1 is v4-only; block_private has no opinion on v6 or garbage.
    expect(ipIsPrivateV4('::1')).toBe(false);
    expect(ipIsPrivateV4('fe80::1')).toBe(false);
    expect(ipIsPrivateV4('not-an-ip')).toBe(false);
    expect(ipIsPrivateV4('')).toBe(false);
  });
});

describe('resolveAllowlist', () => {
  it('resolves a single hostname to a host entry + an allowed IP', async () => {
    const result = await resolveAllowlist(
      { ...BASE_POLICY, allowlist: ['api.example.com'] },
      { resolver: resolverFrom({ 'api.example.com': ['93.184.216.34'] }) },
    );
    expect(result.hosts).toEqual([{ name: 'api.example.com', ip: '93.184.216.34' }]);
    expect(result.allowedIps).toEqual(['93.184.216.34']);
  });

  it('accepts literal IPv4 allowlist entries without a host entry', async () => {
    // Literals don't need DNS and don't contribute to /etc/hosts.
    const result = await resolveAllowlist(
      { ...BASE_POLICY, allowlist: ['1.1.1.1', '8.8.8.8'] },
      { resolver: resolverFrom({}) },
    );
    expect(result.hosts).toEqual([]);
    expect(result.allowedIps).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('dedupes + sorts allowedIps', async () => {
    const result = await resolveAllowlist(
      {
        ...BASE_POLICY,
        allowlist: ['one.example.com', 'two.example.com', 'cdn.example.com'],
      },
      {
        resolver: resolverFrom({
          'one.example.com': ['140.82.112.6'],
          'two.example.com': ['140.82.112.6'], // same IP, different hostname
          'cdn.example.com': ['1.2.3.4'],
        }),
      },
    );
    expect(result.allowedIps).toEqual(['1.2.3.4', '140.82.112.6']);
    // hosts still has three entries — the /etc/hosts mapping is
    // per-name, not per-IP.
    expect(result.hosts).toHaveLength(3);
  });

  it('includes ALL resolved IPs of a hostname in allowedIps', async () => {
    // DNS round-robin — a host with multiple IPs should have each
    // whitelisted so the guest can connect to any of them.
    const result = await resolveAllowlist(
      { ...BASE_POLICY, allowlist: ['api.example.com'] },
      { resolver: resolverFrom({ 'api.example.com': ['1.1.1.1', '1.0.0.1'] }) },
    );
    expect(result.allowedIps.sort()).toEqual(['1.0.0.1', '1.1.1.1']);
    // Only ONE /etc/hosts entry — picks the first resolved IP.
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]?.ip).toBe('1.1.1.1');
  });

  it('rejects wildcard allowlist with a clear message', async () => {
    await expect(
      resolveAllowlist(
        { ...BASE_POLICY, allowlist: ['*'] },
        { resolver: resolverFrom({}) },
      ),
    ).rejects.toThrow(/enumerable allowlist/);
  });

  it('rejects wildcard mixed with other entries', async () => {
    await expect(
      resolveAllowlist(
        { ...BASE_POLICY, allowlist: ['api.example.com', '*'] },
        { resolver: resolverFrom({ 'api.example.com': ['1.1.1.1'] }) },
      ),
    ).rejects.toThrow(/enumerable allowlist/);
  });

  it('surfaces DNS resolution failures with the hostname in the message', async () => {
    await expect(
      resolveAllowlist(
        { ...BASE_POLICY, allowlist: ['nonexistent.example'] },
        { resolver: resolverFrom({}) },
      ),
    ).rejects.toThrow(/nonexistent\.example/);
  });

  it('rejects a literal IP that the policy blocks', async () => {
    await expect(
      resolveAllowlist(
        {
          ...BASE_POLICY,
          allowlist: ['169.254.169.254'],
          block_metadata: true,
        },
        { resolver: resolverFrom({}) },
      ),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('rejects a literal private IP when block_private is on', async () => {
    await expect(
      resolveAllowlist(
        {
          ...BASE_POLICY,
          allowlist: ['10.0.0.5'],
          block_private: true,
        },
        { resolver: resolverFrom({}) },
      ),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('filters blocked IPs out of a hostname resolution', async () => {
    // A hostname that resolves to a mix of blocked + non-blocked IPs
    // keeps only the usable ones. If the user explicitly needed the
    // blocked one, they'd have noticed by now; we prefer partial
    // success over blanket rejection.
    const result = await resolveAllowlist(
      {
        ...BASE_POLICY,
        allowlist: ['mixed.example.com'],
        block_private: true,
      },
      {
        resolver: resolverFrom({
          'mixed.example.com': ['10.0.0.1', '1.2.3.4'],
        }),
      },
    );
    expect(result.allowedIps).toEqual(['1.2.3.4']);
    expect(result.hosts[0]?.ip).toBe('1.2.3.4');
  });

  it('throws when a hostname resolves to ONLY blocked IPs', async () => {
    await expect(
      resolveAllowlist(
        {
          ...BASE_POLICY,
          allowlist: ['private.internal'],
          block_private: true,
        },
        { resolver: resolverFrom({ 'private.internal': ['10.0.0.1', '192.168.1.1'] }) },
      ),
    ).rejects.toThrow(/all blocked by policy/);
  });

  it('ignores IPv6 literals in v1 (accepted shape but not enforced)', async () => {
    // RED-259 v1 is v4-only at iptables; v6 literals should be
    // accepted shape-wise but not contribute to allowedIps. Forward-
    // compat: they become real rules when v6 iptables lands.
    const result = await resolveAllowlist(
      { ...BASE_POLICY, allowlist: ['::1', '2606:4700:4700::1111'] },
      { resolver: resolverFrom({}) },
    );
    expect(result.allowedIps).toEqual([]);
    expect(result.hosts).toEqual([]);
  });

  it('empty allowlist produces empty output (not an error)', async () => {
    // A gen with `network: 'none'` never reaches resolution. But a
    // gen with `network: { allowlist: [] }` is shape-valid and should
    // produce a valid (empty) ResolvedAllowlist without throwing —
    // the resulting iptables rules have no ACCEPTs and DEFAULT DROP
    // blocks everything, effectively equivalent to 'none'.
    const result = await resolveAllowlist(BASE_POLICY, {
      resolver: resolverFrom({}),
    });
    expect(result.hosts).toEqual([]);
    expect(result.allowedIps).toEqual([]);
  });
});
