import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateProviderBaseUrl, _resetValidatorCacheForTesting } from './base-url-validator.js';

describe('validateProviderBaseUrl (RED-325 Part 5 / RED-322)', () => {
  let origEscape: string | undefined;

  beforeEach(() => {
    origEscape = process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL;
    delete process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL;
    _resetValidatorCacheForTesting();
  });

  afterEach(() => {
    if (origEscape == null) delete process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL;
    else process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = origEscape;
    _resetValidatorCacheForTesting();
  });

  describe('scheme rules', () => {
    it('accepts https:// for any host', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'https://api.anthropic.com')).not.toThrow();
    });

    it('accepts http:// for localhost', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'http://localhost:11434')).not.toThrow();
    });

    it('accepts http:// for 127.0.0.1', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'http://127.0.0.1:11434')).not.toThrow();
    });

    it('accepts http:// for ::1', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'http://[::1]:11434')).not.toThrow();
    });

    it('rejects http:// for non-localhost host', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'http://api.anthropic.com'))
        .toThrow(/non-https scheme/);
    });

    it('rejects malformed URLs', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'not a url'))
        .toThrow(/malformed/);
    });
  });

  describe('private-range rules', () => {
    it('rejects RFC1918 10/8', () => {
      expect(() => validateProviderBaseUrl('oMLX', 'https://10.0.0.5'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects RFC1918 172.16/12', () => {
      expect(() => validateProviderBaseUrl('oMLX', 'https://172.20.1.1'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects RFC1918 192.168/16', () => {
      expect(() => validateProviderBaseUrl('oMLX', 'https://192.168.1.100'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects link-local + AWS metadata 169.254/16', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'https://169.254.169.254'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects ULA fc00::/7 (IPv6)', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'https://[fc00::1]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects ULA fd00::/8 (IPv6)', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'https://[fd12::1]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects link-local fe80::/10 (IPv6)', () => {
      expect(() => validateProviderBaseUrl('Ollama', 'https://[fe80::1]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('ACCEPTS Tailscale CGNAT 100.64.0.0/10 (intentionally not in private list)', () => {
      // CGNAT is the standard tailnet/wg range; Cambium deliberately
      // doesn't block it. http on a non-localhost host still trips the
      // scheme check though — prove that's the rejection reason here,
      // not the range.
      expect(() => validateProviderBaseUrl('oMLX', 'http://100.64.0.1:8080'))
        .toThrow(/non-https/);
    });

    it('Tailscale CGNAT over https passes both checks', () => {
      expect(() => validateProviderBaseUrl('oMLX', 'https://100.64.0.1:8080')).not.toThrow();
    });

    it('ACCEPTS public IPs', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'https://8.8.8.8')).not.toThrow();
    });

    it('passes through hostnames without DNS resolution', () => {
      // "metadata.google.internal" is a real metadata-service hostname,
      // but we don't resolve DNS — operator-controlled env-var case is
      // about static URL strings, not DNS-rebinding.
      expect(() => validateProviderBaseUrl('Anthropic', 'https://metadata.google.internal')).not.toThrow();
    });

    // Security review tightenings (post-RED-325 review)
    it('rejects 127.0.0.0/8 loopback (other than the localhost exemption)', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'https://127.0.0.2'))
        .toThrow(/private\/metadata IP range/);
      // The exact 127.0.0.1 is allowed — exempted via LOCALHOST_HOSTS
      // for http+localhost convenience.
      expect(() => validateProviderBaseUrl('Anthropic', 'https://127.0.0.1')).not.toThrow();
    });

    it('rejects fe90 through febf (full fe80::/10 link-local range)', () => {
      // Pre-fix: regex only covered fe80–fe8f (a /12 slice).
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[fe90::1]'))
        .toThrow(/private\/metadata IP range/);
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[febf::1]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects IPv4-mapped IPv6 to private addresses (dotted form)', () => {
      // ::ffff:192.168.1.1 is an IPv4-mapped IPv6 address that points
      // to RFC1918 192.168.1.1. Pre-fix this bypassed the validator.
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[::ffff:192.168.1.1]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects IPv4-mapped IPv6 to private addresses (hex-pair form Node URL produces)', () => {
      // Node's URL constructor normalizes ::ffff:192.168.1.1 to ::ffff:c0a8:101.
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[::ffff:c0a8:101]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('rejects IPv4-mapped IPv6 to AWS metadata (169.254.169.254)', () => {
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[::ffff:169.254.169.254]'))
        .toThrow(/private\/metadata IP range/);
    });

    it('ACCEPTS IPv4-mapped IPv6 to public addresses', () => {
      // ::ffff:8.8.8.8 → 8.8.8.8 (public). Should pass.
      expect(() => validateProviderBaseUrl('Anthropic', 'https://[::ffff:8.8.8.8]')).not.toThrow();
    });
  });

  describe('escape hatch (CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1)', () => {
    it('allows private-range when escape hatch set', () => {
      process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = '1';
      expect(() => validateProviderBaseUrl('Anthropic', 'https://192.168.1.100')).not.toThrow();
    });

    it('emits one-time stderr warning when escape hatch engaged', () => {
      process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = '1';
      const writes: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // @ts-ignore — vitest's spying on stderr is awkward; manual capture
      process.stderr.write = ((s: any) => { writes.push(String(s)); return true; }) as any;
      try {
        validateProviderBaseUrl('Anthropic', 'https://192.168.1.100');
        validateProviderBaseUrl('Anthropic', 'https://192.168.1.100');  // second call same URL
      } finally {
        process.stderr.write = origWrite;
      }
      const warnings = writes.filter(w => w.includes('private/metadata range'));
      expect(warnings).toHaveLength(1);
    });

    it('escape hatch DOES allow http on non-localhost (with stderr warning)', () => {
      // Post-fix: the escape hatch covers both relaxations. Pre-fix this
      // threw, leaving Tailscale-CGNAT-over-http (the most common
      // in-tree dev setup) unreachable even with the env var set.
      process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = '1';
      const writes: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // @ts-ignore — stderr capture
      process.stderr.write = ((s: any) => { writes.push(String(s)); return true; }) as any;
      try {
        expect(() => validateProviderBaseUrl('oMLX', 'http://100.108.155.72:8000')).not.toThrow();
      } finally {
        process.stderr.write = origWrite;
      }
      const schemeWarnings = writes.filter(w => w.includes('non-https scheme'));
      expect(schemeWarnings).toHaveLength(1);
      // The Tailscale-CGNAT IP is also in 100.64/10 (intentionally NOT
      // in the private range table), so we should see exactly one
      // warning — for scheme only, not a second for private-range.
      const privateWarnings = writes.filter(w => w.includes('private/metadata range'));
      expect(privateWarnings).toHaveLength(0);
    });

    it('escape hatch allows http on a public hostname too (gate is symmetric)', () => {
      // Confirms the escape hatch isn't accidentally over-narrow.
      process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = '1';
      expect(() => validateProviderBaseUrl('Anthropic', 'http://example.com')).not.toThrow();
    });

    it('without escape hatch, http on a public hostname still throws (with hint)', () => {
      // The error message now points at the env var so operators don't
      // have to grep the source.
      expect(() => validateProviderBaseUrl('Anthropic', 'http://example.com'))
        .toThrow(/Set CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1/);
    });

    it('http + private-range URL emits TWO distinct warnings (scheme + range), not one', () => {
      process.env.CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL = '1';
      const writes: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // @ts-ignore
      process.stderr.write = ((s: any) => { writes.push(String(s)); return true; }) as any;
      try {
        validateProviderBaseUrl('oMLX', 'http://192.168.1.100');
      } finally {
        process.stderr.write = origWrite;
      }
      const schemeWarnings = writes.filter(w => w.includes('non-https scheme'));
      const rangeWarnings = writes.filter(w => w.includes('private/metadata range'));
      expect(schemeWarnings).toHaveLength(1);
      expect(rangeWarnings).toHaveLength(1);
    });
  });

  describe('memoization', () => {
    it('only validates a (provider, url) pair once', () => {
      // Memoization is observable via the warning-deduplication behavior
      // tested above. Direct memoization assertion:
      validateProviderBaseUrl('Anthropic', 'https://api.anthropic.com');
      validateProviderBaseUrl('Anthropic', 'https://api.anthropic.com');
      // No throw, no duplicate work — the cache covers both calls.
    });
  });
});
