// RED-360: `cambium serve` CLI subcommand.
//
// Thin orchestration layer: parses --workspace and --bind, calls
// runServe from the runner package, wires SIGTERM/SIGINT to a graceful
// shutdown. The runner package owns the actual HTTP/dispatch logic;
// this module is just argv glue and signal handling.

import { resolve } from 'node:path';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage:
  cambium serve --workspace <path> --bind <uri> [flags]

Flags:
  --workspace <path>   Path to the workspace containing Genfile.toml.
                       Defaults to the current directory.
  --bind <uri>         Bind address. One of:
                         tcp://127.0.0.1:9000     (loopback, default form)
                         unix:///tmp/cambium.sock (Mac/Linux UDS)
                         pipe://cambium           (Windows named pipe)
  --allow-remote       Allow non-loopback tcp:// binds. The runner is
                       unauthenticated in v1; only pass this when the
                       bind address is isolated by the orchestrator.
  --max-inflight <n>   Cap concurrent /v1/run dispatches. Over-cap
                       requests get HTTP 503 + error.kind=overloaded.
                       Defaults to unlimited.
  --run-timeout <s>    Per-call deadline in seconds. /v1/run that doesn't
                       finish in time returns HTTP 504 + error.kind=timeout.
                       v1 semantic: frees the inflight slot but does not
                       cancel the underlying run (the runner has no
                       cooperative cancellation). Defaults to unlimited.
  --shutdown-timeout <s>
                       SIGTERM/SIGINT drain deadline in seconds. After this,
                       lingering HTTP connections are force-closed and the
                       process exits. Defaults to 30s.
  --help, -h           Show this help.

Examples:
  cambium serve --workspace . --bind tcp://127.0.0.1:9000
  cambium serve --workspace ../redwood-ats/cambium --bind unix:///tmp/cambium.sock
`);
  process.exit(2);
}

export async function runServeCli(args) {
  let workspace = '.';
  let bindUri = null;
  let allowRemote = false;
  let maxInflight; // undefined → unlimited
  let runTimeoutMs; // undefined → unlimited
  let shutdownTimeoutMs; // undefined → server default (30s)

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') workspace = args[++i];
    else if (a === '--bind') bindUri = args[++i];
    else if (a === '--allow-remote') allowRemote = true;
    else if (a === '--max-inflight') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        usage(`--max-inflight must be a positive integer (got '${raw}').`);
      }
      maxInflight = n;
    }
    else if (a === '--run-timeout') {
      const raw = args[++i];
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        usage(`--run-timeout must be a positive number of seconds (got '${raw}').`);
      }
      runTimeoutMs = Math.round(seconds * 1000);
    }
    else if (a === '--shutdown-timeout') {
      const raw = args[++i];
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        usage(`--shutdown-timeout must be a positive number of seconds (got '${raw}').`);
      }
      shutdownTimeoutMs = Math.round(seconds * 1000);
    }
    else if (a === '--help' || a === '-h') usage();
    else usage(`Unknown flag: ${a}`);
  }

  if (!bindUri) {
    usage('Missing --bind.');
  }

  const { runServe, parseBind } = await import('@redwood-labs/cambium-runner');

  let bind;
  try {
    bind = parseBind(bindUri, { allowRemote });
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(2);
  }

  const handle = runServe({
    workspaceDir: resolve(workspace),
    bind,
    maxInflight,
    runTimeoutMs,
    shutdownTimeoutMs,
  });

  try {
    const addr = await handle.ready;
    process.stderr.write(`[cambium serve] listening on ${describeAddress(addr)}\n`);
    process.stderr.write(`[cambium serve] workspace: ${resolve(workspace)}\n`);
  } catch (err) {
    console.error(`[cambium serve] boot failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Block until a signal arrives. Returning from this function lets the
  // outer cambium.mjs hit `process.exit(0)`, killing the server before
  // it can drain — so we hold here until shutdown completes.
  await new Promise((resolveSignal) => {
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`\n[cambium serve] received ${signal}, draining...\n`);
      try {
        await handle.close();
      } catch (err) {
        process.stderr.write(`[cambium serve] shutdown error: ${err?.message ?? err}\n`);
      }
      resolveSignal();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}

function describeAddress(addr) {
  if (addr.kind === 'tcp') return `tcp://${addr.host}:${addr.port}`;
  if (addr.kind === 'unix') return `unix://${addr.path}`;
  return `pipe://${addr.pipePath}`;
}
