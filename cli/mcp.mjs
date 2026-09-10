// #198: `cambium mcp` CLI subcommand.
//
// Thin argv glue, mirroring `cli/serve.mjs`: parses flags, calls
// `runMcpStdio` from the runner package, wires SIGTERM/SIGINT to a
// graceful shutdown. The runner package owns the MCP protocol + the
// private-socket adapter (`packages/cambium-runner/src/mcp/mcp-stdio.ts`);
// this module is just argv glue, signal handling, and the two
// process-level guarantees a library function can't make on its own:
// stdout is protocol-only (DEC-009's `console.log = console.error`
// rebind), and boot failure / stdin EOF map to exit codes 1 / 0.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunner } from './runner-freshness.mjs';

// Same derivation as `cli/serve.mjs` — resolves correctly regardless of
// where node_modules sits (RED-376).
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const COMPILE_RB = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage:
  cambium mcp --workspace <path> [flags]

Speaks MCP over stdio: one typed tool per gen×method (\`GenName__method\`),
derived from this workspace's \`/v1/gens\` catalog. See
\`docs/GenDSL Docs/C - MCP Mode.md\`.

Flags:
  --workspace <path>   Path to the workspace containing Genfile.toml.
                       Defaults to the current directory.
  --precompiled        Boot from each gen's sibling <gen>.ir.json artifact
                       instead of spawning ruby compile.rb — no Ruby
                       needed on PATH. Same semantics as
                       \`cambium serve --precompiled\`.
  --ir-dir <dir>       Like --precompiled, but every artifact lives flat
                       under <dir>/<basename>.ir.json. Implies
                       --precompiled; wins when both are passed.
  --mock               Use the deterministic mock generator instead of a
                       live LLM on every tools/call dispatch.
  --help, -h           Show this help.

Examples:
  cambium mcp --workspace .
  cambium mcp --workspace . --mock
  cambium mcp --workspace . --precompiled
`);
  process.exit(2);
}

export async function runMcpCli(args) {
  let workspace = '.';
  let precompiled = false;
  let irDir; // undefined → sibling-artifact resolution (or Ruby compile-at-boot)
  let mock = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace') workspace = args[++i];
    else if (a === '--precompiled') precompiled = true;
    else if (a === '--ir-dir') irDir = args[++i];
    else if (a === '--mock') mock = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`Unknown flag: ${a}`);
  }

  // DEC-009 belt-and-braces: `cambium mcp`'s stdout is protocol-only. A
  // stray library/tool `console.log` would otherwise corrupt the JSON-RPC
  // stream — redirect it to stderr for the lifetime of this process.
  // eslint-disable-next-line no-console
  console.log = console.error;

  // DEC-009a (audit round 1, closes AUD-198-03): harden stdout purity to
  // the write level, not just console.log. Capture the REAL
  // process.stdout.write first — the frame writer below is handed this
  // captured reference directly as `output`, bypassing the rebind below
  // entirely — then repoint process.stdout.write itself at stderr, so an
  // in-process plugin tool/corrector/log-sink that writes directly via
  // `process.stdout.write(...)` during a run can no longer corrupt the
  // protocol stream either. Unit tests never go through this module (they
  // inject `input`/`output` streams straight into `runMcpStdio`), so the
  // rebind only ever fires when this CLI is driving real process stdio.
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (...writeArgs) {
    return process.stderr.write(...writeArgs);
  };

  // DEC-003: mirror `cambium run --ir`'s belt-and-braces mock handling —
  // both the option AND the env var, since some runner internals read
  // CAMBIUM_ALLOW_MOCK directly. `cambium mcp` is long-lived for the life
  // of the process, so there is no env var to restore on return.
  if (mock) process.env.CAMBIUM_ALLOW_MOCK = '1';

  const { runMcpStdio } = await loadRunner();

  const handle = runMcpStdio({
    workspaceDir: resolve(workspace),
    compileRb: COMPILE_RB,
    precompiled,
    irDir: irDir === undefined ? undefined : resolve(irDir),
    mock,
    output: { write: rawStdoutWrite },
  });

  try {
    await handle.ready;
    process.stderr.write(`[cambium mcp] ready (stdio)\n`);
    process.stderr.write(`[cambium mcp] workspace: ${resolve(workspace)}\n`);
  } catch (err) {
    console.error(`[cambium mcp] boot failed: ${err?.message ?? err}`);
    // AUD-198-02 (audit round 1): the private socket tmpdir is created
    // before boot can fail (makePrivateBind runs first), so a boot
    // rejection still leaves it on disk unless we clean up here —
    // handle.close() is idempotent, null-safe, and owns the rmSync; this
    // keeps exactly one owner of teardown rather than adding a second
    // cleanup path inside runMcpStdio's `ready` rejection.
    await handle.close().catch(() => {});
    process.exit(1);
  }

  process.on('SIGTERM', () => {
    process.stderr.write(`\n[cambium mcp] received SIGTERM, closing...\n`);
    handle.close();
  });
  process.on('SIGINT', () => {
    process.stderr.write(`\n[cambium mcp] received SIGINT, closing...\n`);
    handle.close();
  });

  // Block until stdin hits EOF (the client disconnected) or a signal
  // triggered handle.close(). Returning from this function lets the
  // outer cambium.mjs hit `process.exit(0)`.
  await handle.closed;
}
