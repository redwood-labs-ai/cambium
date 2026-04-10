import { describe, it, expect } from 'vitest'
import { validateToolPermissions, buildSecurityPolicy, DEFAULT_POLICY } from './permissions.js'

describe('tool permissions', () => {
  it('passes for pure tools with default policy', () => {
    const def = { name: 'calculator', description: '', inputSchema: {}, outputSchema: {}, permissions: { pure: true } };
    const violations = validateToolPermissions(def, DEFAULT_POLICY);
    expect(violations).toHaveLength(0);
  })

  it('blocks network tools with default policy', () => {
    const def = { name: 'api_client', description: '', inputSchema: {}, outputSchema: {}, permissions: { network: true } };
    const violations = validateToolPermissions(def, DEFAULT_POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0].permission).toBe('network');
  })

  it('allows network tools when policy permits', () => {
    const def = { name: 'api_client', description: '', inputSchema: {}, outputSchema: {}, permissions: { network: true } };
    const policy = { ...DEFAULT_POLICY, allow_network: true };
    const violations = validateToolPermissions(def, policy);
    expect(violations).toHaveLength(0);
  })

  it('blocks network hosts not in allowlist', () => {
    const def = { name: 'api_client', description: '', inputSchema: {}, outputSchema: {}, permissions: { network: true, network_hosts: ['evil.com'] } };
    const policy = { ...DEFAULT_POLICY, allow_network: true, network_hosts_allowlist: ['api.example.com'] };
    const violations = validateToolPermissions(def, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('evil.com');
  })

  it('allows network hosts in allowlist', () => {
    const def = { name: 'api_client', description: '', inputSchema: {}, outputSchema: {}, permissions: { network: true, network_hosts: ['api.example.com'] } };
    const policy = { ...DEFAULT_POLICY, allow_network: true, network_hosts_allowlist: ['api.example.com'] };
    const violations = validateToolPermissions(def, policy);
    expect(violations).toHaveLength(0);
  })

  it('blocks filesystem tools with default policy', () => {
    const def = { name: 'file_read', description: '', inputSchema: {}, outputSchema: {}, permissions: { filesystem: true } };
    const violations = validateToolPermissions(def, DEFAULT_POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0].permission).toBe('filesystem');
  })

  it('blocks exec tools with default policy', () => {
    const def = { name: 'shell', description: '', inputSchema: {}, outputSchema: {}, permissions: { exec: true } };
    const violations = validateToolPermissions(def, DEFAULT_POLICY);
    expect(violations).toHaveLength(1);
    expect(violations[0].permission).toBe('exec');
  })

  it('treats tools without permissions as pure', () => {
    const def = { name: 'calculator', description: '', inputSchema: {}, outputSchema: {} };
    const violations = validateToolPermissions(def, DEFAULT_POLICY);
    expect(violations).toHaveLength(0);
  })
})

describe('buildSecurityPolicy', () => {
  it('returns default deny-all policy when no security config', () => {
    const policy = buildSecurityPolicy({});
    expect(policy.allow_network).toBe(false);
    expect(policy.allow_filesystem).toBe(false);
    expect(policy.allow_exec).toBe(false);
  })

  it('reads policy from IR', () => {
    const policy = buildSecurityPolicy({
      security: { allow_network: true, network_hosts_allowlist: ['api.example.com'] }
    });
    expect(policy.allow_network).toBe(true);
    expect(policy.network_hosts_allowlist).toEqual(['api.example.com']);
  })
})
