// RED-397: forward the parent process's real piped stdin to the Ruby
// compiler child when `--arg -` is passed explicitly.
//
// `compile.rb` honors `--arg -` by doing `STDIN.read`, but spawnSync does
// NOT connect the parent's stdin to the child unless we pass it as `input`.
// Before this fix, `printf '…' | cambium run … --arg -` read the pipe into
// Node and dropped it — Ruby's STDIN.read returned empty, so the gen ran
// against `context.document: ""` with no error (a silent-wrong-result bug).

import { readFileSync } from 'node:fs';

/**
 * Read the parent's piped stdin for an explicit `--arg -`. Returns the
 * piped bytes as a string (possibly empty if the user piped nothing).
 *
 * Throws when stdin is a TTY (no pipe attached) — otherwise `readFileSync(0)`
 * would block forever waiting on the terminal, which reads as a hang. The
 * caller should print the message and exit non-zero.
 *
 * @param {string} label - command label for the error message, e.g. "cambium run".
 */
export function readExplicitStdinArg(label) {
  if (process.stdin.isTTY) {
    throw new Error(
      `${label}: --arg - reads input from stdin, but stdin is a terminal ` +
        `(nothing is piped in). Pipe data (e.g. \`printf '...' | ${label} ... --arg -\`) ` +
        `or pass a file path with --arg <path>.`,
    );
  }
  // fd 0 = stdin. Reads to EOF; works for pipes, heredocs, and redirects.
  return readFileSync(0, 'utf8');
}
