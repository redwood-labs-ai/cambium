import { describe, it, expect } from 'vitest';
import {
  buildNetnsForwardRules,
  METADATA_IP,
  PRIVATE_CIDRS,
} from './firecracker-netns.js';
import type { NetworkPolicy } from '../tools/permissions.js';

/**
 * Unit tests for the pure TS helpers in firecracker-netns.ts. The
 * spawn-driven setup + teardown functions need Linux + CAP_NET_ADMIN
 * and are exercised end-to-end by `firecracker-testbed/netns-preflight.sh`
 * + the RED-259 escape-test matrix extension (Linux-gated).
 */

const BASE_POLICY: NetworkPolicy = {
  allowlist: [],
  denylist: [],
  block_private: false,
  block_metadata: false,
};

describe('buildNetnsForwardRules', () => {
  it('always emits the stateful RELATED,ESTABLISHED ACCEPT first', () => {
    // This rule is load-bearing for TCP replies. Without it, guest
    // SYN goes out, SYN-ACK comes back, netns FORWARD has default
    // DROP, SYN-ACK is dropped → connection times out. The first
    // rule in the chain MUST be the stateful ACCEPT.
    const rules = buildNetnsForwardRules([], BASE_POLICY);
    expect(rules[0]).toEqual([
      '-A', 'FORWARD', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT',
    ]);
  });

  it('emits no per-IP rules when the allowlist is empty', () => {
    const rules = buildNetnsForwardRules([], BASE_POLICY);
    // Only the stateful rule. Default policy (set elsewhere) is DROP,
    // so with no allowlist + no metadata/private blocks, only replies
    // pass.
    expect(rules).toHaveLength(1);
  });

  it('emits one ACCEPT per unique allowlist IP', () => {
    const rules = buildNetnsForwardRules(
      ['1.1.1.1', '140.82.112.6', '1.1.1.1'], // duplicate intentional
      BASE_POLICY,
    );
    const accepts = rules.filter((r) => r.includes('-A') && r.includes('ACCEPT') && r.includes('-d'));
    expect(accepts).toHaveLength(2);
    // Sorted — canonicalization makes rule ordering deterministic,
    // which matters if we ever snapshot the rules for a cache key.
    expect(accepts[0]).toContain('1.1.1.1');
    expect(accepts[1]).toContain('140.82.112.6');
  });

  it('places block_metadata DROP BEFORE any allowlist ACCEPT', () => {
    // Invariant: an allowlist entry whose resolved IP == metadata IP
    // still gets dropped. Order of rules matters here — if the ACCEPT
    // were first, the DROP would be unreachable.
    const rules = buildNetnsForwardRules(
      [METADATA_IP, '1.1.1.1'], // metadata in allowlist (shouldn't happen but test the invariant)
      { ...BASE_POLICY, block_metadata: true },
    );
    const dropIdx = rules.findIndex((r) => r.includes(METADATA_IP) && r.includes('DROP'));
    const metadataAcceptIdx = rules.findIndex(
      (r) => r.includes(METADATA_IP) && r.includes('ACCEPT'),
    );
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(metadataAcceptIdx).toBeGreaterThan(dropIdx);
  });

  it('places block_private DROP rules for each private CIDR', () => {
    const rules = buildNetnsForwardRules([], { ...BASE_POLICY, block_private: true });
    for (const cidr of PRIVATE_CIDRS) {
      expect(
        rules.some((r) => r.includes(cidr) && r.includes('DROP')),
        `expected DROP rule for ${cidr}`,
      ).toBe(true);
    }
  });

  it('places block_private DROPs BEFORE allowlist ACCEPTs', () => {
    // Same invariant as block_metadata — a private-IP allowlist entry
    // must still be dropped when block_private is on.
    const rules = buildNetnsForwardRules(
      ['10.0.0.5', '1.1.1.1'],
      { ...BASE_POLICY, block_private: true },
    );
    const privateDropIdx = rules.findIndex((r) => r.includes('10.0.0.0/8') && r.includes('DROP'));
    const privateAcceptIdx = rules.findIndex(
      (r) => r.includes('10.0.0.5') && r.includes('ACCEPT'),
    );
    expect(privateDropIdx).toBeGreaterThanOrEqual(0);
    expect(privateAcceptIdx).toBeGreaterThan(privateDropIdx);
  });

  it('omits block_metadata DROP when the flag is false', () => {
    const rules = buildNetnsForwardRules([], BASE_POLICY);
    const hasMetaDrop = rules.some((r) => r.includes(METADATA_IP) && r.includes('DROP'));
    expect(hasMetaDrop).toBe(false);
  });

  it('omits block_private DROPs when the flag is false', () => {
    const rules = buildNetnsForwardRules([], BASE_POLICY);
    const hasPrivateDrop = rules.some(
      (r) => PRIVATE_CIDRS.some((c) => r.includes(c)) && r.includes('DROP'),
    );
    expect(hasPrivateDrop).toBe(false);
  });

  it('produces deterministic output for the same inputs', () => {
    // Stability matters for cache-key derivation (if we ever hash the
    // rule set) and for diff-readability in traces.
    const a = buildNetnsForwardRules(
      ['1.1.1.1', '8.8.8.8'],
      { ...BASE_POLICY, block_metadata: true, block_private: true },
    );
    const b = buildNetnsForwardRules(
      ['8.8.8.8', '1.1.1.1'], // reversed input order — shouldn't matter
      { ...BASE_POLICY, block_metadata: true, block_private: true },
    );
    expect(a).toEqual(b);
  });
});
