/**
 * WASM substrate worker (AUD-003 fix).
 *
 * Runs QuickJS evalCode in a worker_threads context so the main Node
 * event loop is never blocked. The parent spawns this worker, feeds opts
 * via workerData, and posts a single ExecResult message back. If the
 * parent's kill-timer fires first (the interrupt handler didn't trip in
 * time), it calls worker.terminate() and builds its own timeout result —
 * this worker's postMessage is then irrelevant.
 *
 * Plain .mjs (not .ts) so it doesn't need TypeScript compilation and
 * works from both the src/ tree (vitest) and the dist/ tree (published).
 * copy-assets.mjs copies it to dist/exec-substrate/ during the build.
 */
import { workerData, parentPort } from 'node:worker_threads';

function truncate(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  return { text: `${s.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]`, truncated: true };
}

function formatDumped(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function formatError(e) {
  if (e && typeof e === 'object' && (e.message || e.name)) {
    return `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim();
  }
  return formatDumped(e);
}

function buildResult(status, stdoutBuf, stderrBuf, maxOutputBytes, durationMs, reason, exitCode) {
  const stdoutCap = truncate(stdoutBuf.join('\n'), maxOutputBytes);
  const stderrCap = truncate(stderrBuf.join('\n'), maxOutputBytes);
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

const { code, memory, timeout, maxOutputBytes } = workerData;
const startedAt = Date.now();
const deadline = startedAt + timeout * 1000;

let runtime = null;
const stdoutBuf = [];
const stderrBuf = [];
let timedOut = false;

try {
  const mod = await import('quickjs-emscripten');
  const quickjs = await mod.getQuickJS();

  runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(memory * 1024 * 1024);
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const context = runtime.newContext();

  const consoleObj = context.newObject();
  const logFn = context.newFunction('log', (...args) => {
    stdoutBuf.push(args.map(h => context.dump(h)).map(formatDumped).join(' '));
  });
  const errFn = context.newFunction('error', (...args) => {
    stderrBuf.push(args.map(h => context.dump(h)).map(formatDumped).join(' '));
  });
  context.setProp(consoleObj, 'log', logFn);
  context.setProp(consoleObj, 'error', errFn);
  context.setProp(context.global, 'console', consoleObj);
  logFn.dispose();
  errFn.dispose();
  consoleObj.dispose();

  const evalResult = context.evalCode(code);
  const durationMs = Date.now() - startedAt;

  if (evalResult.error) {
    const err = context.dump(evalResult.error);
    evalResult.error.dispose();
    const errString = formatError(err);

    if (timedOut && /interrupted/i.test(errString)) {
      parentPort.postMessage(
        buildResult('timeout', stdoutBuf, stderrBuf, maxOutputBytes, durationMs,
          `wall-clock timeout (${timeout}s)`),
      );
    } else if (/out of memory/i.test(errString)) {
      parentPort.postMessage(
        buildResult('oom', stdoutBuf, stderrBuf, maxOutputBytes, durationMs,
          `memory limit reached (${memory} MB)`),
      );
    } else {
      stderrBuf.push(errString);
      parentPort.postMessage(
        buildResult('completed', stdoutBuf, stderrBuf, maxOutputBytes, durationMs, undefined, 1),
      );
    }
    context.dispose();
  } else {
    evalResult.value.dispose();
    context.dispose();
    parentPort.postMessage(
      buildResult('completed', stdoutBuf, stderrBuf, maxOutputBytes, durationMs, undefined, 0),
    );
  }
} catch (e) {
  parentPort.postMessage({
    status: 'crashed',
    stdout: truncate(stdoutBuf.join('\n'), maxOutputBytes).text,
    stderr: truncate(stderrBuf.join('\n'), maxOutputBytes).text,
    truncated: { stdout: false, stderr: false },
    durationMs: Date.now() - startedAt,
    reason: e?.message ?? String(e),
  });
} finally {
  try { runtime?.dispose(); } catch {}
}
