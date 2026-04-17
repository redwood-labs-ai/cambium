import { describe, it, expect } from 'vitest';
import {
  ipInCidr,
  isPrivateIp,
  checkHost,
  checkAndResolve,
} from './network-guard.js';
import type { NetworkPolicy } from './permissions.js';

const policy = (overrides: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  allowlist: ['*'],
  denylist: [],
  block_private: true,
  block_metadata: true,
  ...overrides,
});

describe('ipInCidr (v4)', () => {
  it('matches inside RFC1918', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0', 8)).toBe(true);
    expect(ipInCidr('192.168.1.1', '192.168.0.0', 16)).toBe(true);
    expect(ipInCidr('172.16.5.1', '172.16.0.0', 12)).toBe(true);
    expect(ipInCidr('172.31.5.1', '172.16.0.0', 12)).toBe(true);
    expect(ipInCidr('172.32.0.0', '172.16.0.0', 12)).toBe(false);
  });
  it('matches loopback', () => {
    expect(ipInCidr('127.0.0.1', '127.0.0.0', 8)).toBe(true);
    expect(ipInCidr('128.0.0.1', '127.0.0.0', 8)).toBe(false);
  });
  it('handles /32 and /0', () => {
    expect(ipInCidr('1.2.3.4', '1.2.3.4', 32)).toBe(true);
    expect(ipInCidr('1.2.3.5', '1.2.3.4', 32)).toBe(false);
    expect(ipInCidr('8.8.8.8', '0.0.0.0', 0)).toBe(true);
  });
});

describe('ipInCidr (v6)', () => {
  it('matches loopback', () => {
    expect(ipInCidr('::1', '::1', 128)).toBe(true);
  });
  it('matches link-local fe80::/10', () => {
    expect(ipInCidr('fe80::1', 'fe80::', 10)).toBe(true);
    expect(ipInCidr('febf::1', 'fe80::', 10)).toBe(true);
    expect(ipInCidr('fec0::1', 'fe80::', 10)).toBe(false);
  });
  it('matches ULA fc00::/7', () => {
    expect(ipInCidr('fc00::1', 'fc00::', 7)).toBe(true);
    expect(ipInCidr('fdff::1', 'fc00::', 7)).toBe(true);
    expect(ipInCidr('fe00::1', 'fc00::', 7)).toBe(false);
  });
});

describe('isPrivateIp', () => {
  it('flags loopback, RFC1918, link-local, ULA', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
  });
  it('passes public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('2606:4700::1111')).toBe(false);
  });
});

describe('checkHost — IP literals', () => {
  it('blocks private IP literal even with wildcard allowlist', () => {
    const d = checkHost('169.254.169.254', policy());
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      // metadata catch happens before private-range catch
      expect(d.reason).toBe('block_metadata');
    }
  });
  it('blocks private IP not in metadata set', () => {
    const d = checkHost('192.168.1.1', policy());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('block_private');
  });
  it('allows public IP literal under wildcard', () => {
    const d = checkHost('8.8.8.8', policy());
    expect(d.allowed).toBe(true);
  });
  it('rejects public IP literal when allowlist has no wildcard', () => {
    const d = checkHost('8.8.8.8', policy({ allowlist: ['api.example.com'] }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('allowlist_miss');
  });
});

describe('checkHost — hostnames', () => {
  it('denies when allowlist is empty', () => {
    const d = checkHost('api.example.com', policy({ allowlist: [] }));
    expect(d.allowed).toBe(false);
  });
  it('allows wildcard', () => {
    const d = checkHost('api.example.com', policy());
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.matched).toBe('wildcard');
  });
  it('allows exact match', () => {
    const d = checkHost('api.example.com', policy({ allowlist: ['api.example.com'] }));
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.matched).toBe('allowlist');
  });
  it('denies prefix-collision attack', () => {
    const d = checkHost('evilexample.com', policy({ allowlist: ['example.com'] }));
    expect(d.allowed).toBe(false);
  });
  it('denylist wins over allowlist', () => {
    const d = checkHost('bad.example.com', policy({
      allowlist: ['example.com'],
      denylist: ['bad.example.com'],
    }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('denylist');
  });
  it('blocks metadata hostname even under wildcard', () => {
    const d = checkHost('metadata.google.internal', policy());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('block_metadata');
  });
});

describe('checkAndResolve — DNS path', () => {
  it('rejects bad URL', async () => {
    const d = await checkAndResolve('not a url', policy());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('invalid_url');
  });
  it('rejects non-http(s) protocol', async () => {
    const d = await checkAndResolve('file:///etc/passwd', policy());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('unsupported_protocol');
  });
  it('blocks if any resolved IP is private (DNS rebinding)', async () => {
    const resolver = async () => [
      { address: '8.8.8.8',     family: 4 as const },
      { address: '127.0.0.1',   family: 4 as const },
    ];
    const d = await checkAndResolve('https://attacker.example/', policy({ allowlist: ['*'] }), { resolver });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe('block_private');
      expect(d.resolved_ips).toEqual(['8.8.8.8', '127.0.0.1']);
    }
  });
  it('allows when all resolved IPs are public', async () => {
    const resolver = async () => [
      { address: '8.8.8.8', family: 4 as const },
      { address: '8.8.4.4', family: 4 as const },
    ];
    const d = await checkAndResolve('https://api.tavily.com/search', policy({ allowlist: ['api.tavily.com'] }), { resolver });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.resolved_ips).toEqual(['8.8.8.8', '8.8.4.4']);
      expect(d.matched).toBe('allowlist');
    }
  });
  it('handles unresolvable hostnames', async () => {
    const resolver = async () => { throw new Error('NXDOMAIN'); };
    const d = await checkAndResolve('https://nonexistent.invalid/', policy(), { resolver });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('unresolvable');
  });
  it('blocks resolved metadata IP', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 as const }];
    const d = await checkAndResolve('https://innocent-looking.example/', policy({ allowlist: ['*'] }), { resolver });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      // 169.254.169.254 is private (link-local), so block_private trips first.
      expect(['block_private', 'block_metadata']).toContain(d.reason);
    }
  });
});
