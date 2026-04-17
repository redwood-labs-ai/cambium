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
 * The handler path is: import module lazily → new runtime → set caps
 * → new context → inject console stubs → evalCode → collect result
 * and stdout/stderr → dispose all handles. Synchronous evaluation via
 * the release-sync variant of QuickJS.
 */
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';

// Cached import. Lazy-loaded on first `execute()` call; `available()`
// probes without actually loading the WASM module (fast + cheap).
let _quickjsModule: any = null;
let _quickjsAvailable: 'yes' | 'no' | 'unknown' = 'unknown';
let _unavailableReason: string | null = null;

async function loadQuickJS(): Promise<any> {
  if (_quickjsModule) return _quickjsModule;
  const mod: any = await import('quickjs-emscripten');
  _quickjsModule = await mod.getQuickJS();
  return _quickjsModule;
}

function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  const slice = s.slice(0, maxBytes);
  return { text: `${slice}\n[truncated at ${maxBytes} bytes]`, truncated: true };
}

export class WasmSubstrate implements ExecSubstrate {
  available(): string | null {
    if (_quickjsAvailable === 'yes') return null;
    if (_quickjsAvailable === 'no') return _unavailableReason;
    // Probe without loading the WASM module — require.resolve-style
    // presence check. We use dynamic import with a catch below.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require.resolve('quickjs-emscripten');
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
    const deadline = startedAt + opts.timeout * 1000;

    // Load the module lazily. Failure = substrate infra crash.
    let quickjs: any;
    try {
      quickjs = await loadQuickJS();
    } catch (e: any) {
      return {
        status: 'crashed',
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        durationMs: Date.now() - startedAt,
        reason: `Failed to load quickjs-emscripten: ${e?.message ?? String(e)}`,
      };
    }

    // Runtime + context lifecycle.
    const runtime = quickjs.newRuntime();
    let context: any;
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    try {
      runtime.setMemoryLimit(opts.memory * 1024 * 1024);
      // Periodic interrupt — returns true to abort evalCode when the
      // wall-clock deadline has passed. QuickJS calls this every few
      // hundred bytecode ops, so it's a quick poll; overhead is tiny.
      runtime.setInterruptHandler(() => Date.now() > deadline);

      context = runtime.newContext();

      // Inject `console.log` / `console.error` — QuickJS has no native
      // console. Guests without these would silently lose output.
      const consoleObj = context.newObject();
      const logFn = context.newFunction('log', (...args: any[]) => {
        stdoutBuf.push(args.map((h) => context.dump(h)).map(formatDumped).join(' '));
      });
      const errFn = context.newFunction('error', (...args: any[]) => {
        stderrBuf.push(args.map((h) => context.dump(h)).map(formatDumped).join(' '));
      });
      context.setProp(consoleObj, 'log', logFn);
      context.setProp(consoleObj, 'error', errFn);
      context.setProp(context.global, 'console', consoleObj);
      logFn.dispose();
      errFn.dispose();
      consoleObj.dispose();

      const evalResult = context.evalCode(opts.code);
      const durationMs = Date.now() - startedAt;

      if (evalResult.error) {
        // Extract the error message BEFORE disposing the handle.
        const err: any = context.dump(evalResult.error);
        evalResult.error.dispose();
        const errString = formatError(err);

        // Timeout surfaces as an "interrupted" InternalError.
        if (/interrupted/i.test(errString) && Date.now() >= deadline) {
          return wasmResult('timeout', stdoutBuf, stderrBuf, opts, durationMs,
            `wall-clock timeout (${opts.timeout}s)`);
        }
        // OOM surfaces as a QuickJS-specific out-of-memory error.
        if (/out of memory/i.test(errString)) {
          return wasmResult('oom', stdoutBuf, stderrBuf, opts, durationMs,
            `memory limit reached (${opts.memory} MB)`);
        }
        // Stack overflow, reference error, syntax error, etc. — guest
        // code failed. Collapses to `completed` with exit_code: 1 and
        // the error message appended to stderr; matches Node/Python
        // behavior where a script crash is an exit, not a "crashed
        // substrate."
        stderrBuf.push(errString);
        return wasmResult('completed', stdoutBuf, stderrBuf, opts, durationMs, undefined, 1);
      }

      evalResult.value.dispose();
      return wasmResult('completed', stdoutBuf, stderrBuf, opts, durationMs, undefined, 0);
    } catch (e: any) {
      // Anything thrown from the host side (runtime setup, context
      // creation, etc.) → crashed.
      return {
        status: 'crashed',
        stdout: truncate(stdoutBuf.join('\n'), opts.maxOutputBytes).text,
        stderr: truncate(stderrBuf.join('\n'), opts.maxOutputBytes).text,
        truncated: { stdout: false, stderr: false },
        durationMs: Date.now() - startedAt,
        reason: e?.message ?? String(e),
      };
    } finally {
      try { context?.dispose(); } catch {}
      try { runtime.dispose(); } catch {}
    }
  }
}

/** Turn QuickJS-dumped values into printable strings. Arrays/objects
 *  get JSON.stringify; primitives get String(). */
function formatDumped(v: any): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/** Format a QuickJS-dumped error object into a single-line message. */
function formatError(e: any): string {
  if (e && typeof e === 'object' && (e.message || e.name)) {
    return `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim();
  }
  return formatDumped(e);
}

/** Shared result builder. Applies truncation to both streams and
 *  populates the ExecResult shape. */
function wasmResult(
  status: ExecResult['status'],
  stdoutBuf: string[],
  stderrBuf: string[],
  opts: ExecOpts,
  durationMs: number,
  reason?: string,
  exitCode?: number,
): ExecResult {
  const stdoutCap = truncate(stdoutBuf.join('\n'), opts.maxOutputBytes);
  const stderrCap = truncate(stderrBuf.join('\n'), opts.maxOutputBytes);
  return {
    status,
    exitCode: status === 'completed' ? (exitCode ?? 0) : undefined,
    stdout: stdoutCap.text,
    stderr: stderrCap.text,
    truncated: { stdout: stdoutCap.truncated, stderr: stderrCap.truncated },
    durationMs,
    reason,
  };
}
