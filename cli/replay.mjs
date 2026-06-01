// ── cambium replay (RED-312) ────────────────────────────────────────
//
// Re-execute the post-Generate tail of a prior run against its candidate
// output, optionally edited. The expensive Generate (and tool calls)
// stays paid-for; you iterate only on the cheap deterministic tail
// (validate → correct → repair → grounding).
//
//   cambium replay <run-id>                  resume from output.json
//   cambium replay <run-id> --edit           open $EDITOR on the candidate first
//   cambium replay <run-id> --from-step Correct   resume from a trace step's output
//   cambium replay runs/run_2026...          path form also accepted
//
// The new run writes a fresh runs/<id>/ with parent_run_id set, so the
// replay chain is walkable.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const RUBY_COMPILE_SCRIPT = resolve(CLI_DIR, '..', 'ruby', 'cambium', 'compile.rb');

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n\n`);
  process.stderr.write(`Usage: cambium replay <run-id|path> [options]

Re-run a prior run's post-Generate tail from its candidate output.

Options (gen runs):
  --edit                Open the candidate in $EDITOR before replaying
  --from-step <type>    Resume from a trace step type's output (default: output.json)

Options (pipeline runs):
  --from-op <id>        Resume from a specific operator (default: first incomplete)

Common:
  --trace <path>        Write trace JSON to <path>
  --out <path>          Write output JSON to <path>
  --mock                Run any downstream repair / re-run in mock mode
  -h, --help            Show this help

Examples:
  cambium replay run_20260422_114135_abc
  cambium replay run_20260422_114135_abc --edit
  cambium replay runs/run_20260422_114135_abc --from-step Correct
  cambium replay run_20260422_114135_abc --from-op fix
`);
  process.exit(msg ? 2 : 0);
}

/** Open `$EDITOR` on the candidate JSON and return the edited value.
 *  Re-prompts on malformed JSON; aborts on an empty file. */
function editCandidate(candidate) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const dir = mkdtempSync(join(tmpdir(), 'cambium-replay-'));
  const file = join(dir, 'candidate.json');
  writeFileSync(file, JSON.stringify(candidate, null, 2));

  for (let attempt = 0; attempt < 5; attempt++) {
    const ed = spawnSync(editor, [file], { stdio: 'inherit' });
    if (ed.status !== 0 && ed.error) {
      throw new Error(`replay: failed to launch $EDITOR (${editor}): ${ed.error.message}`);
    }
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') {
      process.stderr.write('replay: empty candidate — aborting (nothing saved).\n');
      process.exit(1);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      process.stderr.write(
        `replay: candidate is not valid JSON (${e?.message ?? e}). Re-opening editor…\n`,
      );
    }
  }
  throw new Error('replay: gave up after 5 invalid-JSON edits.');
}

export async function runReplay(args) {
  if (args.includes('--help') || args.includes('-h')) usage();

  const runRef = args[0];
  if (!runRef || runRef.startsWith('-')) usage('Missing <run-id|path>');

  let edit = false;
  let fromStep = null;
  let fromOp = null;
  let traceOut = null;
  let outputOut = null;
  let mock = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--edit') edit = true;
    else if (a === '--from-step') fromStep = args[++i];
    else if (a === '--from-op') fromOp = args[++i];
    else if (a === '--trace') traceOut = args[++i];
    else if (a === '--out') outputOut = args[++i];
    else if (a === '--mock') mock = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`Unknown flag: ${a}`);
  }

  const runner = await import('@redwood-labs/cambium-runner');
  const { resolveReplay } = runner;

  let resolved;
  try {
    resolved = resolveReplay({
      runRef,
      cwd: process.cwd(),
      fromStep: fromStep ?? undefined,
      fromOp: fromOp ?? undefined,
    });
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }

  const previousMockEnv = process.env.CAMBIUM_ALLOW_MOCK;
  if (mock) process.env.CAMBIUM_ALLOW_MOCK = '1';
  try {
    let result;
    if (resolved.kind === 'pipeline') {
      if (edit) {
        usage('--edit is gen-level only; pipeline replay resumes operators (no single candidate to edit).');
      }
      process.stderr.write(
        `[cambium] replay (pipeline) parent=${resolved.parentRunId} from-op=${resolved.fromOp ?? '<first-incomplete>'}\n`,
      );
      result = await runner.runPipelineFromIr({
        ir: resolved.ir,
        cwd: process.cwd(),
        traceOut: traceOut ?? undefined,
        outputOut: outputOut ?? undefined,
        mock,
        compileRb: RUBY_COMPILE_SCRIPT,
        replay: {
          priorTrace: resolved.priorTrace,
          parentRunId: resolved.parentRunId,
          fromOp: resolved.fromOp,
        },
      });
    } else {
      let candidate = resolved.candidate;
      if (edit) candidate = editCandidate(candidate);
      process.stderr.write(
        `[cambium] replay (gen) parent=${resolved.parentRunId} from=${resolved.fromStep}\n`,
      );
      result = await runner.runGenFromIr({
        ir: resolved.ir,
        cwd: process.cwd(),
        candidate,
        fromStep: resolved.fromStep,
        parentRunId: resolved.parentRunId,
        traceOut: traceOut ?? undefined,
        outputOut: outputOut ?? undefined,
        mock,
      });
    }

    if (!result.ok) {
      if (result.errorMessage) {
        process.stderr.write(`${result.errorMessage}. See ${result.tracePath}\n`);
      }
      process.exit(1);
    }

    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.stderr.write(`Trace: ${result.tracePath} (parent: ${resolved.parentRunId})\n`);
  } catch (err) {
    process.stderr.write(`${err?.stack || String(err)}\n`);
    process.exit(1);
  } finally {
    if (mock) {
      if (previousMockEnv === undefined) delete process.env.CAMBIUM_ALLOW_MOCK;
      else process.env.CAMBIUM_ALLOW_MOCK = previousMockEnv;
    }
  }
}
