/**
 * RED-360 phase 1: parse `--bind` URIs for `cambium serve`.
 *
 * Three schemes:
 *   tcp://host:port      e.g. tcp://127.0.0.1:9000, tcp://[::1]:9000
 *   unix:///abs/path     e.g. unix:///tmp/cambium.sock
 *   pipe://name          e.g. pipe://cambium  →  \\.\pipe\cambium (Windows)
 *
 * The parser's job is two-fold:
 *   1. Turn the URI into a structured target the HTTP server can listen on.
 *   2. Refuse non-loopback TCP binds unless the operator explicitly opts in
 *      via `--allow-remote`. The server is unauthenticated in v1; the only
 *      thing standing between an open bind and the public internet is this
 *      check + the orchestrator's network isolation. Belt-and-suspenders.
 *
 * Platform compatibility (does this OS actually support this scheme?) is
 * checked at server-listen time, NOT here. That keeps this module pure
 * and testable on any platform — the parser produces the target, the
 * listener decides whether to bind.
 */

export type BindTarget =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; path: string }
  | { kind: 'pipe'; name: string; pipePath: string };

export interface ParseBindOptions {
  /** Allow non-loopback `tcp://` binds. Default false. */
  allowRemote?: boolean;
}

const SCHEME_RE = /^([a-z][a-z0-9]*):\/\/(.*)$/i;

// Loopback identifiers we accept without --allow-remote. Everything else
// (0.0.0.0, ::, RFC-1918 ranges, hostnames, public IPs) is "remote" for
// our purposes — the operator must explicitly opt in.
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 — every address with a leading 127 octet is loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export function parseBind(uri: string, opts: ParseBindOptions = {}): BindTarget {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('Invalid --bind URI: expected non-empty string.');
  }

  const m = uri.match(SCHEME_RE);
  if (!m) {
    throw new Error(
      `Invalid --bind URI '${uri}': expected scheme://… (one of tcp, unix, pipe).`,
    );
  }
  const scheme = m[1].toLowerCase();
  const rest = m[2];

  switch (scheme) {
    case 'tcp':
      return parseTcp(uri, rest, opts);
    case 'unix':
      return parseUnix(uri, rest);
    case 'pipe':
      return parsePipe(uri, rest);
    default:
      throw new Error(
        `Invalid --bind URI '${uri}': unknown scheme '${scheme}'. ` +
          'Expected one of: tcp, unix, pipe.',
      );
  }
}

// ── tcp ───────────────────────────────────────────────────────────────

// Two host shapes:
//   bracketed IPv6: [::1]:9000
//   bare host/IPv4: 127.0.0.1:9000, localhost:9000
const TCP_BRACKETED_RE = /^\[([^\]]+)\]:(\d+)$/;
const TCP_BARE_RE = /^([^:]+):(\d+)$/;

function parseTcp(uri: string, rest: string, opts: ParseBindOptions): BindTarget {
  let host: string;
  let portRaw: string;

  const bracketed = rest.match(TCP_BRACKETED_RE);
  if (bracketed) {
    host = bracketed[1];
    portRaw = bracketed[2];
  } else {
    const bare = rest.match(TCP_BARE_RE);
    if (!bare) {
      throw new Error(
        `Invalid --bind URI '${uri}': expected tcp://host:port ` +
          '(IPv6 hosts must be bracketed, e.g. tcp://[::1]:9000).',
      );
    }
    host = bare[1];
    portRaw = bare[2];
  }

  if (host.length === 0) {
    throw new Error(`Invalid --bind URI '${uri}': empty host.`);
  }

  // Port 0 is explicitly allowed — it means "let the OS pick a free port",
  // which is exactly what the spawn-and-fetch test fixtures want.
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid --bind URI '${uri}': port must be an integer 0–65535 (got '${portRaw}').`,
    );
  }

  if (!opts.allowRemote && !isLoopback(host)) {
    throw new Error(
      `Invalid --bind URI '${uri}': non-loopback host '${host}' refused. ` +
        'The serve-mode runner is unauthenticated in v1; binding to a non-loopback ' +
        'address exposes the runner to anything that can reach it. Pass --allow-remote ' +
        'to opt in (and ensure the orchestrator isolates the bind address).',
    );
  }

  return { kind: 'tcp', host, port };
}

// ── unix ──────────────────────────────────────────────────────────────

function parseUnix(uri: string, rest: string): BindTarget {
  // unix:///abs/path — three slashes, the third begins the absolute path.
  // After splitting off the scheme `unix://`, `rest` starts with the
  // remaining `/abs/path`. A relative form (`unix://relative`) is rejected
  // because Node's `server.listen(path)` would resolve it against the
  // process cwd, surprising the operator.
  if (rest.length === 0) {
    throw new Error(
      `Invalid --bind URI '${uri}': expected unix:///path (absolute path required).`,
    );
  }
  if (!rest.startsWith('/')) {
    throw new Error(
      `Invalid --bind URI '${uri}': unix sockets need an absolute path (got '${rest}'). ` +
        'Use unix:///abs/path — note the three slashes.',
    );
  }
  if (rest.includes('\0')) {
    throw new Error(`Invalid --bind URI '${uri}': NUL byte in unix path.`);
  }
  // Reject `..` segments. Node would silently normalise `/tmp/../etc/foo`
  // to `/etc/foo` when binding, surprising operators (and any wrapper
  // script that constructs --bind URIs from user data). Same defensive
  // stance the rest of Cambium takes everywhere user-supplied path
  // segments interpolate into filesystem APIs.
  if (rest === '/..' || rest.includes('/../') || rest.endsWith('/..')) {
    throw new Error(
      `Invalid --bind URI '${uri}': '..' segments not allowed in unix path. ` +
        'Pass the canonical absolute path (Node would otherwise normalise it silently before bind).',
    );
  }
  return { kind: 'unix', path: rest };
}

// ── pipe ──────────────────────────────────────────────────────────────

// Windows named pipes live under \\.\pipe\<name>. The CLI accepts the
// shorter pipe://name form and expands it. Names are restricted to the
// same character set as a directory segment so a malicious name cannot
// inject path components into the resolved Windows pipe path.
const PIPE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;

function parsePipe(uri: string, rest: string): BindTarget {
  if (rest.length === 0) {
    throw new Error(
      `Invalid --bind URI '${uri}': expected pipe://name (e.g. pipe://cambium).`,
    );
  }
  if (!PIPE_NAME_RE.test(rest)) {
    throw new Error(
      `Invalid --bind URI '${uri}': pipe name must match /^[a-zA-Z0-9_\\-]+$/ ` +
        `(got '${rest}'). Slashes, dots, and other path-suggestive characters are rejected ` +
        'because the name is interpolated into a Windows pipe path.',
    );
  }
  return {
    kind: 'pipe',
    name: rest,
    pipePath: `\\\\.\\pipe\\${rest}`,
  };
}
