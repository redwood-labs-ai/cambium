/**
 * `:wasm` substrate — Wasmtime + QuickJS-WASM (RED-247).
 *
 * v1 status: STUB. The adapter-interface + dispatch plumbing ships in
 * this commit; the actual WASM execution is a follow-up within the same
 * ticket. The stub returns `status: 'crashed'` with a clear reason so
 * a gen declaring `runtime: :wasm` surfaces "not yet implemented"
 * rather than silently falling through to :native.
 */
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';

export class WasmSubstrate implements ExecSubstrate {
  available(): string | null {
    // TODO(RED-247): probe for Wasmtime availability (dynamic-import
    // like better-sqlite3 in memory/backend.ts). Until the real
    // implementation lands, mark the substrate unavailable so the
    // runner fails at startup with a clear message instead of
    // mysteriously producing 'crashed' results.
    return 'WASM substrate not yet implemented (RED-247 v1 stub); use runtime: :native for back-compat or runtime: :firecracker for full isolation.';
  }

  async execute(_opts: ExecOpts): Promise<ExecResult> {
    return {
      status: 'crashed',
      stdout: '',
      stderr: '',
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      reason: 'WASM substrate not yet implemented (RED-247 stub)',
    };
  }
}
