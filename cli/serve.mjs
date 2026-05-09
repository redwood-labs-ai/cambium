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

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') workspace = args[++i];
    else if (a === '--bind') bindUri = args[++i];
    else if (a === '--allow-remote') allowRemote = true;
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
