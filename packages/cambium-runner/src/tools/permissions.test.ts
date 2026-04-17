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

// RED-248: resolved ExecPolicy shape + :inherit semantics
describe('buildSecurityPolicy — exec (RED-248)', () => {
  it('legacy { allowed: true, runtime: "native" } carries both fields through', () => {
    const p = buildSecurityPolicy({
      security: { exec: { allowed: true, runtime: 'native' } },
    });
    expect(p.exec).toMatchObject({ allowed: true, runtime: 'native' });
  });

  it('new shape: runtime + cpu + memory + timeout + max_output_bytes all populate', () => {
    const p = buildSecurityPolicy({
      security: {
        exec: {
          runtime: 'wasm',
          cpu: 0.5,
          memory: 128,
          timeout: 10,
          max_output_bytes: 10_000,
        },
      },
    });
    expect(p.exec).toMatchObject({
      runtime: 'wasm',
      cpu: 0.5,
      memory: 128,
      timeout: 10,
      maxOutputBytes: 10_000,
    });
  });

  it('network: "none" resolves to the string "none" (no network capability)', () => {
    const p = buildSecurityPolicy({
      security: { exec: { runtime: 'wasm', network: 'none' } },
    });
    expect(p.exec?.network).toBe('none');
  });

  it('network: "inherit" copies the outer NetworkPolicy wholesale', () => {
    const p = buildSecurityPolicy({
      security: {
        network: { allowlist: ['api.example.com'], denylist: [], block_private: true, block_metadata: true },
        exec: { runtime: 'wasm', network: 'inherit' },
      },
    });
    expect(p.exec?.network).toEqual({
      allowlist: ['api.example.com'],
      denylist: [],
      block_private: true,
      block_metadata: true,
    });
  });

  it('network: "inherit" with no outer network resolves to "none" (safer default)', () => {
    const p = buildSecurityPolicy({
      security: { exec: { runtime: 'wasm', network: 'inherit' } },
    });
    expect(p.exec?.network).toBe('none');
  });

  it('network as a Hash resolves to a NetworkPolicy with defaults applied', () => {
    const p = buildSecurityPolicy({
      security: {
        exec: { runtime: 'firecracker', network: { allowlist: ['internal.example.com'] } },
      },
    });
    expect(p.exec?.network).toEqual({
      allowlist: ['internal.example.com'],
      denylist: [],
      block_private: true,
      block_metadata: true,
    });
  });

  it('filesystem: "none" stays as "none"', () => {
    const p = buildSecurityPolicy({
      security: { exec: { runtime: 'wasm', filesystem: 'none' } },
    });
    expect(p.exec?.filesystem).toBe('none');
  });

  it('filesystem as a Hash resolves to { allowlist_paths: [...] }', () => {
    const p = buildSecurityPolicy({
      security: {
        exec: { runtime: 'wasm', filesystem: { allowlist_paths: ['/data', '/sandbox/in'] } },
      },
    });
    expect(p.exec?.filesystem).toEqual({
      allowlist_paths: ['/data', '/sandbox/in'],
    });
  });

  // RED-248 security review Finding 2: TS-side re-validates runtime so
  // a tampered/hand-crafted IR can't smuggle an arbitrary string into
  // getSubstrate at dispatch time.
  it('rejects an unknown runtime string (defense-in-depth vs tampered IR)', () => {
    expect(() =>
      buildSecurityPolicy({
        security: { exec: { runtime: 'gvisor' } },
      }),
    ).toThrow(/Invalid security\.exec\.runtime: "gvisor"/);
  });

  it('rejects "__proto__" as a runtime (proto-safety at the policy layer)', () => {
    expect(() =>
      buildSecurityPolicy({
        security: { exec: { runtime: '__proto__' } },
      }),
    ).toThrow(/Invalid security\.exec\.runtime/);
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
