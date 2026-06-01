// RED-313: `cambium inspect` CLI subcommand.
//
// Thin orchestration: resolve which runs/ dir to read, start the local
// read-only trace viewer (runInspect from the runner package), print the URL,
// best-effort open the browser, and keep alive until a signal. The runner
// package owns the HTTP/projection logic; this is argv + signal glue.

import { spawn } from 'node:child_process';
import process from 'node:process';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
cambium inspect — local read-only trace viewer

Usage:
  cambium inspect [run-id] [flags]

Args:
  run-id              Optional. Deep-link straight to a run (opens it selected).

Flags:
  --port <n>          Port to bind (default 3210; CAMBIUM_INSPECT_PORT overrides).
  --runs-dir <path>   Explicit runs/ directory (default: <engineDir>/runs or <cwd>/runs).
  --host <host>       Bind host (default 127.0.0.1 — localhost only).
  --allow-remote      Required to bind a non-loopback host. The viewer serves
                      run outputs (model I/O, grounding docs) and is UNAUTHENTICATED;
                      only use behind a trusted network boundary.
  --no-open           Don't auto-open the browser.
`);
  process.exit(msg ? 2 : 0);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {}); // best-effort; ignore if opener missing
    child.unref();
  } catch {
    /* ignore */
  }
}

export async function runInspectCli(args) {
  let runId = null;
  let port = process.env.CAMBIUM_INSPECT_PORT ? Number(process.env.CAMBIUM_INSPECT_PORT) : 3210;
  let runsDirOverride;
  let host = '127.0.0.1';
  let open = true;
  let allowRemote = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`--port must be 0–65535.`);
    } else if (a === '--runs-dir') runsDirOverride = args[++i];
    else if (a === '--host') host = args[++i];
    else if (a === '--allow-remote') allowRemote = true;
    else if (a === '--no-open') open = false;
    else if (a === '--help' || a === '-h') usage();
    else if (!a.startsWith('-') && runId === null) runId = a;
    else usage(`Unknown flag: ${a}`);
  }

  const { runInspect, resolveRunsDir, isLoopback } = await import('@redwood-labs/cambium-runner');

  // The viewer is unauthenticated and serves run outputs. Refuse a non-loopback
  // bind unless the operator explicitly opts in — same gate as `cambium serve`.
  if (!isLoopback(host) && !allowRemote) {
    usage(
      `Refusing to bind non-loopback host '${host}' without --allow-remote. ` +
        `The inspector is unauthenticated and serves run outputs (model I/O, grounding docs).`,
    );
  }

  const runsDir = resolveRunsDir(process.cwd(), runsDirOverride);

  let handle;
  try {
    handle = await runInspect({ runsDir, host, port });
  } catch (err) {
    console.error(`cambium inspect: ${err?.message ?? String(err)}`);
    process.exit(1);
  }

  const url = runId ? `${handle.url}/?run=${encodeURIComponent(runId)}` : handle.url;
  console.error(`[cambium] inspect serving ${runsDir}`);
  console.error(`[cambium] open ${url}`);
  if (open) openBrowser(url);

  // Block until a signal arrives, then drain + close. Returning resolves the
  // caller's await; the dispatcher exits cleanly after (mirrors `serve`).
  await new Promise((resolveShutdown) => {
    const shutdown = async () => {
      await handle.close();
      resolveShutdown();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
