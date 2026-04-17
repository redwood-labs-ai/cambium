/**
 * `:native` substrate — back-compat fig-leaf (RED-213 design note §10).
 *
 * Runs code via `execSync` with no sandbox. Exists so existing gens with
 * `security exec: { allowed: true }` continue to compile and run; the
 * runner emits a `tool.exec.unsandboxed` trace step and a stderr
 * deprecation warning on every call (RED-249 wires those).
 *
 * MUST NOT be the default for new gens. The scaffolder emits
 * `runtime: :wasm`; this path only exists for migration.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';

const LANGUAGE_CONFIG: Record<string, { ext: string; cmd: (path: string) => string }> = {
  python: { ext: '.py', cmd: (p) => `python3 "${p}"` },
  js: { ext: '.js', cmd: (p) => `node "${p}"` },
};

function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  const slice = s.slice(0, maxBytes);
  return { text: `${slice}\n[truncated at ${maxBytes} bytes]`, truncated: true };
}

export class NativeSubstrate implements ExecSubstrate {
  available(): string | null {
    // :native works everywhere Node works. The substrate is by-design
    // unsandboxed — the deprecation warning is emitted by the trace
    // layer (RED-249), not here.
    return null;
  }

  async execute(opts: ExecOpts): Promise<ExecResult> {
    const config = LANGUAGE_CONFIG[opts.language];
    if (!config) {
      return {
        status: 'crashed',
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        reason: `:native substrate does not support language "${opts.language}". Supported: ${Object.keys(LANGUAGE_CONFIG).join(', ')}.`,
      };
    }

    const startedAt = Date.now();
    const workDir = mkdtempSync(join(tmpdir(), 'cambium-native-'));
    const scriptPath = join(workDir, `script${config.ext}`);
    writeFileSync(scriptPath, opts.code);

    try {
      // execSync's `maxBuffer` is a hard cap that turns overflow into a
      // thrown error indistinguishable from a timeout at the catch site.
      // Give it plenty of headroom and let `truncate()` handle the
      // user-visible cap in userland so we can report truncated: true
      // instead of losing the output entirely.
      const EXEC_BUFFER_HEADROOM = Math.max(opts.maxOutputBytes * 100, 5 * 1024 * 1024);
      const stdout = execSync(config.cmd(scriptPath), {
        encoding: 'utf8',
        timeout: opts.timeout * 1000,
        // Native substrate can't enforce memory; substrates that can
        // enforce it populate ExecResult.memPeakMb. We omit it here
        // by design — the "fig leaf" name reflects this.
        maxBuffer: EXEC_BUFFER_HEADROOM,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdoutCap = truncate(stdout ?? '', opts.maxOutputBytes);
      return {
        status: 'completed',
        exitCode: 0,
        stdout: stdoutCap.text,
        stderr: '',
        truncated: { stdout: stdoutCap.truncated, stderr: false },
        durationMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;

      // Timeout surfaces as ETIMEDOUT on err.code; the signal alone
      // (SIGTERM) is ambiguous because execSync also sends SIGTERM for
      // maxBuffer overflow. Be specific here so buffer-overflow doesn't
      // masquerade as a timeout.
      const isTimeout = err.code === 'ETIMEDOUT' ||
        (err.signal === 'SIGTERM' && durationMs >= opts.timeout * 1000 * 0.9);
      if (isTimeout) {
        return {
          status: 'timeout',
          stdout: truncate(String(err.stdout ?? ''), opts.maxOutputBytes).text,
          stderr: truncate(String(err.stderr ?? ''), opts.maxOutputBytes).text,
          truncated: { stdout: false, stderr: false },
          durationMs,
          reason: `wall-clock timeout (${opts.timeout}s)`,
        };
      }

      // Non-zero exit from the code itself — this is `completed`, not
      // `crashed`. Crashed is reserved for substrate-infra failures.
      const stdoutCap = truncate(String(err.stdout ?? ''), opts.maxOutputBytes);
      const stderrCap = truncate(String(err.stderr ?? err.message ?? ''), opts.maxOutputBytes);
      return {
        status: 'completed',
        exitCode: err.status ?? 1,
        stdout: stdoutCap.text,
        stderr: stderrCap.text,
        truncated: { stdout: stdoutCap.truncated, stderr: stderrCap.truncated },
        durationMs,
      };
    } finally {
      try { unlinkSync(scriptPath); } catch {}
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}
