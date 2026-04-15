import { describe, it, expect } from 'vitest'
import {
  validateToolPermissions,
  buildSecurityPolicy,
  hostMatchesList,
  DEFAULT_POLICY,
  type SecurityPolicy,
} from './permissions.js'

const tool = (name: string, permissions: any = undefined) => ({
  name, description: '', inputSchema: {}, outputSchema: {}, permissions,
});

const netPolicy = (allowlist: string[] = ['*'], extra: Partial<SecurityPolicy['network']> = {}): SecurityPolicy => ({
  network: {
    allowlist,
    denylist: [],
    block_private: true,
    block_metadata: true,
    ...extra,
  } as any,
});

describe('validateToolPermissions', () => {
  it('passes for pure tools with default (empty) policy', () => {
    expect(validateToolPermissions(tool('calc', { pure: true }), DEFAULT_POLICY)).toHaveLength(0);
  });

  it('treats undeclared permissions as pure', () => {
    expect(validateToolPermissions(tool('calc'), DEFAULT_POLICY)).toHaveLength(0);
  });

  it('blocks network tools when policy has no network: block', () => {
    const v = validateToolPermissions(tool('api', { network: true }), DEFAULT_POLICY);
    expect(v).toHaveLength(1);
    expect(v[0].permission).toBe('network');
  });

  it('allows network tools when policy.network is present with wildcard', () => {
    const v = validateToolPermissions(tool('api', { network: true }), netPolicy(['*']));
    expect(v).toHaveLength(0);
  });

  it('blocks tool host not in gen allowlist', () => {
    const v = validateToolPermissions(
      tool('api', { network: true, network_hosts: ['evil.com'] }),
      netPolicy(['api.example.com']),
    );
    expect(v).toHaveLength(1);
    expect(v[0].permission).toBe('host');
    expect(v[0].message).toContain('evil.com');
  });

  it('allows tool host that matches gen allowlist', () => {
    const v = validateToolPermissions(
      tool('api', { network: true, network_hosts: ['api.example.com'] }),
      netPolicy(['api.example.com']),
    );
    expect(v).toHaveLength(0);
  });

  it('blocks filesystem tools when no filesystem: policy block', () => {
    const v = validateToolPermissions(tool('reader', { filesystem: true }), DEFAULT_POLICY);
    expect(v).toHaveLength(1);
    expect(v[0].permission).toBe('filesystem');
  });

  it('allows filesystem tools when policy has filesystem block', () => {
    const v = validateToolPermissions(
      tool('reader', { filesystem: true }),
      { filesystem: { roots: ['./src'] } },
    );
    expect(v).toHaveLength(0);
  });

  it('blocks exec tools by default', () => {
    expect(validateToolPermissions(tool('shell', { exec: true }), DEFAULT_POLICY)).toHaveLength(1);
  });

  it('blocks exec tools when exec.allowed is false', () => {
    const v = validateToolPermissions(tool('shell', { exec: true }), { exec: { allowed: false } });
    expect(v).toHaveLength(1);
  });

  it('allows exec tools when exec.allowed is true', () => {
    const v = validateToolPermissions(tool('shell', { exec: true }), { exec: { allowed: true } });
    expect(v).toHaveLength(0);
  });
});

describe('buildSecurityPolicy', () => {
  it('returns empty policy when IR has no security block', () => {
    expect(buildSecurityPolicy({})).toEqual({});
  });

  it('parses network block with defaults for block_private/block_metadata', () => {
    const p = buildSecurityPolicy({
      security: { network: { allowlist: ['api.tavily.com'] } },
    });
    expect(p.network).toEqual({
      allowlist: ['api.tavily.com'],
      denylist: [],
      block_private: true,
      block_metadata: true,
    });
  });

  it('respects explicit block_private: false', () => {
    const p = buildSecurityPolicy({
      security: { network: { allowlist: ['*'], block_private: false } },
    });
    expect(p.network?.block_private).toBe(false);
    expect(p.network?.block_metadata).toBe(true);
  });

  it('parses filesystem and exec blocks', () => {
    const p = buildSecurityPolicy({
      security: { filesystem: { roots: ['./examples'] }, exec: { allowed: true } },
    });
    expect(p.filesystem?.roots).toEqual(['./examples']);
    expect(p.exec?.allowed).toBe(true);
  });
});

describe('hostMatchesList', () => {
  it('exact match', () => {
    expect(hostMatchesList('api.example.com', ['api.example.com'])).toBe(true);
  });
  it('subdomain match via dot-suffix', () => {
    expect(hostMatchesList('v2.api.example.com', ['api.example.com'])).toBe(true);
  });
  it('wildcard matches anything', () => {
    expect(hostMatchesList('anything.tld', ['*'])).toBe(true);
  });
  it('does not match the prefix-collision attack', () => {
    expect(hostMatchesList('evilexample.com', ['example.com'])).toBe(false);
  });
  it('case insensitive', () => {
    expect(hostMatchesList('API.Example.COM', ['api.example.com'])).toBe(true);
  });
  it('returns false for empty list', () => {
    expect(hostMatchesList('api.example.com', [])).toBe(false);
  });
});
