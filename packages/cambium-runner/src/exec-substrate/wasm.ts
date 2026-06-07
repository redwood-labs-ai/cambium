/**
 * `:wasm` substrate — QuickJS-in-WASM via `quickjs-emscripten` (RED-254).
 *
 * Runs guest JavaScript inside a QuickJS interpreter compiled to
 * WebAssembly. Node's built-in `WebAssembly` support hosts it; no
 * native binding, no separate runtime binary. Shipped as an
 * `optionalDependency` so installs that don't use exec never pay for
 * the WASM module download.
 *
 * v1 scope:
 *   - JS only. Python rejected with a pointer to `:firecracker`.
 *   - No filesystem capability. `filesystem` on ExecOpts is accepted
 *     but any access attempt by guest code fails (no FS host functions
 *     exposed).
 *   - No network capability. Same — `fetch` / `XMLHttpRequest` etc.
 *     are not injected. The substrate surfaces any network attempt as
 *     `status: 'egress_denied'`.
 *   - Memory cap enforced by QuickJS's `setMemoryLimit`.
 *   - Wall-clock timeout enforced by `setInterruptHandler` returning
 *     true once the deadline passes.
 *   - CPU cap accepted but NOT enforced (design-note decision — "by
 *     the time you're worrying about CPU cap, you're past engine
 *     mode"). Recorded in trace meta for observability.
 *
 * The handler path: spawn a worker_threads Worker (wasm-worker.mjs) with
 * opts passed via workerData → worker runs evalCode synchronously inside its
 * own thread → worker posts one ExecResult message → parent resolves. The
 * main event loop is never blocked (AUD-003). The parent's kill timer fires
 * opts.timeout + 500 ms after spawn and calls worker.terminate() as a
 * backstop in case the QuickJS interrupt handler doesn't trip in time.
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';

// `require.resolve` is the cheap synchronous "is this package installed"
// probe we want for `available()`, but this file is an ESM module
// (package.json "type": "module"), so a bare `require` is undefined
// at module scope under Node 22+ strict ESM. Use `createRequire`
// bound to the current module URL to get an ESM-safe `require` whose
// `.resolve()` works as expected. Flagged by a cambium-security
// review that caught the `require.resolve()` anti-pattern before it
// could silently mis-report the WASM substrate unavailable in prod.
const esmRequire = createRequire(import.meta.url);

// `available()` availability cache — cached after the first probe.
let _quickjsAvailable: 'yes' | 'no' | 'unknown' = 'unknown';
let _unavailableReason: string | null = null;

export class WasmSubstrate implements ExecSubstrate {
  available(): string | null {
    if (_quickjsAvailable === 'yes') return null;
    if (_quickjsAvailable === 'no') return _unavailableReason;
    // Probe without loading the WASM module. `esmRequire.resolve`
    // works in ESM via createRequire(import.meta.url); a bare
    // `require.resolve` would throw ReferenceError at module scope.
    try {
      esmRequire.resolve('quickjs-emscripten');
      _quickjsAvailable = 'yes';
      return null;
    } catch {
      _quickjsAvailable = 'no';
      _unavailableReason =
        'quickjs-emscripten is not installed. ' +
        'Run: npm install quickjs-emscripten';
      return _unavailableReason;
    }
  }

  async execute(opts: ExecOpts): Promise<ExecResult> {
    if (opts.language === 'python') {
      return {
        status: 'crashed',
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        reason:
          'Python is not supported in the :wasm substrate (v1 ships JS only). ' +
          'Use runtime: :firecracker for Python, or wait for Pyodide in v1.5.',
      };
    }

    const startedAt = Date.now();

    // AUD-003: run evalCode in a worker_threads Worker so the main Node
    // event loop is never blocked. The synchronous evalCode path previously
    // froze the host event loop for the full timeout window in serve mode —
    // a single request could stall all concurrent requests and health checks.
    //
    // The Worker calls the same QuickJS code (via wasm-worker.mjs) and
    // posts one ExecResult message. The parent sets a kill timer: if the
    // worker's interrupt handler doesn't trip in time (the interrupt fires
    // every few hundred bytecode ops, so it usually wins), the parent
    // terminates the worker from the main thread and returns a timeout result.
    // The +500 ms buffer gives the interrupt handler room to fire and post its
    // message before the parent's timer fires; it's invisible in the result
    // because the result's durationMs comes from the worker's own timestamp.
    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let worker: Worker;
      try {
        // Pass only the fields the worker uses — do not leak policy objects
        // (opts.network / opts.filesystem) into the worker context (Finding 3
        // from the 2026-06-06 audit review: policy fields in workerData would
        // look usable to a future contributor adding network/fs injection, but
        // guardedFetch / ctx.fetch are not available inside a worker thread).
        worker = new Worker(
          new URL('./wasm-worker.mjs', import.meta.url),
          {
            workerData: {
              code: opts.code,
              memory: opts.memory,
              timeout: opts.timeout,
              maxOutputBytes: opts.maxOutputBytes,
            },
          },
        );
      } catch (e: any) {
        settle({
          status: 'crashed',
          stdout: '', stderr: '',
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - startedAt,
          reason: `Failed to spawn WASM worker: ${e?.message ?? String(e)}`,
        });
        return;
      }

      const killTimer = setTimeout(() => {
        worker.terminate().catch(() => { /* ignore */ });
        settle({
          status: 'timeout',
          stdout: '', stderr: '',
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - startedAt,
          reason: `wall-clock timeout (${opts.timeout}s)`,
        });
      }, opts.timeout * 1000 + 500);

      worker.on('message', (result: ExecResult) => {
        clearTimeout(killTimer);
        worker.terminate().catch(() => { /* ignore */ });
        settle(result);
      });

      worker.on('error', (err: Error) => {
        clearTimeout(killTimer);
        settle({
          status: 'crashed',
          stdout: '', stderr: '',
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - startedAt,
          reason: err.message,
        });
      });
    });
  }
}

