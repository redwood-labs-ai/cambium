/**
 * `:firecracker` substrate — microVM isolation (RED-251).
 *
 * v1 status: STUB. Full implementation deferred to RED-251 per the
 * design-note sequencing ("WASM first, Firecracker second"). The stub
 * exists so `getSubstrate('firecracker')` is defined; `available()`
 * returns a clear reason until RED-251 lands.
 */
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';

export class FirecrackerSubstrate implements ExecSubstrate {
  available(): string | null {
    return 'Firecracker substrate not yet implemented (RED-251); use runtime: :wasm for sandboxed JS or runtime: :native for back-compat.';
  }

  async execute(_opts: ExecOpts): Promise<ExecResult> {
    return {
      status: 'crashed',
      stdout: '',
      stderr: '',
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      reason: 'Firecracker substrate not yet implemented (RED-251 stub)',
    };
  }
}
