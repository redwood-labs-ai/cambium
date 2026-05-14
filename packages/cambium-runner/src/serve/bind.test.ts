import { describe, it, expect } from 'vitest';
import { parseBind, isLoopback } from './bind.js';

describe('parseBind — tcp', () => {
  it('parses a loopback IPv4 host', () => {
    expect(parseBind('tcp://127.0.0.1:9000')).toEqual({
      kind: 'tcp', host: '127.0.0.1', port: 9000,
    });
  });

  it('parses localhost', () => {
    expect(parseBind('tcp://localhost:9000')).toEqual({
      kind: 'tcp', host: 'localhost', port: 9000,
    });
  });

  it('parses bracketed IPv6 loopback', () => {
    expect(parseBind('tcp://[::1]:9000')).toEqual({
      kind: 'tcp', host: '::1', port: 9000,
    });
  });

  it('accepts port 0 (OS picks a free port — used by tests)', () => {
    expect(parseBind('tcp://127.0.0.1:0')).toEqual({
      kind: 'tcp', host: '127.0.0.1', port: 0,
    });
  });

  it('accepts the full 127.0.0.0/8 loopback range', () => {
    expect(parseBind('tcp://127.0.0.99:9000')).toEqual({
      kind: 'tcp', host: '127.0.0.99', port: 9000,
    });
    expect(parseBind('tcp://127.5.6.7:9000')).toEqual({
      kind: 'tcp', host: '127.5.6.7', port: 9000,
    });
  });

  it('rejects 0.0.0.0 without --allow-remote', () => {
    expect(() => parseBind('tcp://0.0.0.0:9000'))
      .toThrow(/non-loopback host '0\.0\.0\.0' refused/);
  });

  it('accepts 0.0.0.0 with --allow-remote', () => {
    expect(parseBind('tcp://0.0.0.0:9000', { allowRemote: true })).toEqual({
      kind: 'tcp', host: '0.0.0.0', port: 9000,
    });
  });

  it('rejects RFC-1918 private addresses without --allow-remote', () => {
    expect(() => parseBind('tcp://192.168.1.10:9000'))
      .toThrow(/non-loopback host '192\.168\.1\.10' refused/);
    expect(() => parseBind('tcp://10.0.0.1:9000'))
      .toThrow(/non-loopback host '10\.0\.0\.1' refused/);
  });

  it('rejects public hostnames without --allow-remote', () => {
    expect(() => parseBind('tcp://example.com:9000'))
      .toThrow(/non-loopback host 'example\.com' refused/);
  });

  it('rejects :: (all-IPv6 wildcard) without --allow-remote', () => {
    expect(() => parseBind('tcp://[::]:9000'))
      .toThrow(/non-loopback host '::' refused/);
  });

  it('accepts :: with --allow-remote', () => {
    expect(parseBind('tcp://[::]:9000', { allowRemote: true })).toEqual({
      kind: 'tcp', host: '::', port: 9000,
    });
  });

  it('rejects missing port', () => {
    expect(() => parseBind('tcp://127.0.0.1'))
      .toThrow(/expected tcp:\/\/host:port/);
  });

  it('rejects non-numeric port', () => {
    expect(() => parseBind('tcp://127.0.0.1:abc'))
      .toThrow(/expected tcp:\/\/host:port/);
  });

  it('rejects port out of range', () => {
    expect(() => parseBind('tcp://127.0.0.1:99999'))
      .toThrow(/port must be an integer 0–65535/);
  });

  it('rejects negative port (regex prevents it but the message is clear if it slips through)', () => {
    // The bare regex requires a digit run, so '-1' won't match. Confirm the
    // error path is the URI-shape error, not the port-range error.
    expect(() => parseBind('tcp://127.0.0.1:-1'))
      .toThrow(/expected tcp:\/\/host:port/);
  });

  it('rejects empty host', () => {
    expect(() => parseBind('tcp://:9000'))
      .toThrow(/expected tcp:\/\/host:port/);
  });

  it('rejects IPv6 without brackets', () => {
    // ::1 without brackets is ambiguous (where does host end and port begin?).
    // We require bracketed form for IPv6.
    expect(() => parseBind('tcp://::1:9000'))
      .toThrow(/IPv6 hosts must be bracketed/);
  });
});

describe('parseBind — unix', () => {
  it('parses a standard unix socket path', () => {
    expect(parseBind('unix:///tmp/cambium.sock')).toEqual({
      kind: 'unix', path: '/tmp/cambium.sock',
    });
  });

  it('preserves spaces in unix paths (POSIX allows them)', () => {
    expect(parseBind('unix:///var/run/with space.sock')).toEqual({
      kind: 'unix', path: '/var/run/with space.sock',
    });
  });

  it('rejects relative paths (Node would resolve against cwd, surprising)', () => {
    expect(() => parseBind('unix://relative/path'))
      .toThrow(/unix sockets need an absolute path/);
  });

  it('rejects empty path', () => {
    expect(() => parseBind('unix://'))
      .toThrow(/expected unix:\/\/\/path/);
  });

  it('rejects NUL byte in path', () => {
    expect(() => parseBind('unix:///tmp/foo\0bar'))
      .toThrow(/NUL byte in unix path/);
  });

  it('rejects `..` segments in path (defensive against silent Node normalisation)', () => {
    // Node's server.listen would resolve /tmp/../etc/foo to /etc/foo before
    // binding. Reject explicitly so a wrapper script constructing --bind
    // URIs from user input can't surprise the operator.
    expect(() => parseBind('unix:///tmp/../etc/shadow'))
      .toThrow(/'\.\.' segments not allowed/);
    expect(() => parseBind('unix:///foo/..'))
      .toThrow(/'\.\.' segments not allowed/);
    expect(() => parseBind('unix:///..'))
      .toThrow(/'\.\.' segments not allowed/);
    expect(() => parseBind('unix:///a/../b/../c'))
      .toThrow(/'\.\.' segments not allowed/);
  });

  it('accepts paths with `..` as a literal substring inside a name', () => {
    // `..foo` and `foo..bar` are NOT path-traversal segments — only `..`
    // bounded by `/` (or as the entire trailing segment) is.
    expect(parseBind('unix:///tmp/..foo')).toEqual({ kind: 'unix', path: '/tmp/..foo' });
    expect(parseBind('unix:///tmp/foo..bar')).toEqual({ kind: 'unix', path: '/tmp/foo..bar' });
  });
});

describe('parseBind — pipe', () => {
  it('expands pipe://name to the Windows pipe path', () => {
    expect(parseBind('pipe://cambium')).toEqual({
      kind: 'pipe', name: 'cambium', pipePath: '\\\\.\\pipe\\cambium',
    });
  });

  it('accepts dashes and underscores in names', () => {
    expect(parseBind('pipe://cambium-runner_1')).toEqual({
      kind: 'pipe',
      name: 'cambium-runner_1',
      pipePath: '\\\\.\\pipe\\cambium-runner_1',
    });
  });

  it('rejects empty name', () => {
    expect(() => parseBind('pipe://'))
      .toThrow(/expected pipe:\/\/name/);
  });

  it('rejects path-suggestive characters (slashes, dots, backslashes)', () => {
    expect(() => parseBind('pipe://foo/bar')).toThrow(/pipe name must match/);
    expect(() => parseBind('pipe://foo.bar')).toThrow(/pipe name must match/);
    expect(() => parseBind('pipe://foo\\bar')).toThrow(/pipe name must match/);
  });

  it('rejects whitespace in names', () => {
    expect(() => parseBind('pipe://foo bar')).toThrow(/pipe name must match/);
  });
});

describe('parseBind — scheme dispatch', () => {
  it('rejects empty input', () => {
    expect(() => parseBind('')).toThrow(/expected non-empty string/);
  });

  it('rejects missing scheme', () => {
    expect(() => parseBind('127.0.0.1:9000'))
      .toThrow(/expected scheme:\/\/…/);
  });

  it('rejects unknown scheme', () => {
    expect(() => parseBind('http://127.0.0.1:9000'))
      .toThrow(/unknown scheme 'http'/);
    expect(() => parseBind('tcps://127.0.0.1:9000'))
      .toThrow(/unknown scheme 'tcps'/);
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBind('TCP://127.0.0.1:9000')).toEqual({
      kind: 'tcp', host: '127.0.0.1', port: 9000,
    });
  });
});

describe('isLoopback', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '127.0.0.99',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    'LOCALHOST',  // case-insensitive
  ])('returns true for %s', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.1',
    '10.0.0.1',
    '172.16.0.1',
    'example.com',
    '8.8.8.8',
    '128.0.0.1',  // 128.x is NOT loopback
    '126.0.0.1',  // only 127.x is
  ])('returns false for %s', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});
