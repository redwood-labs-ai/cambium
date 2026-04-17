/**
 * execute_code — dispatches through the exec substrate registry (RED-248).
 *
 * The gen's `security exec:` block determines which substrate runs the
 * code. The legacy `{ allowed: true }` DSL shape resolves to the `:native`
 * substrate (fig-leaf / back-compat). New-shape gens declare `runtime:`
 * explicitly along with `cpu` / `memory` / `timeout` / `network` /
 * `filesystem` / `max_output_bytes` — defaults applied here for anything
 * the author didn't pin.
 *
 * RED-249: structured trace events emitted on every dispatch. The
 * dispatch path pushes `ExecSpawned` before calling the substrate, then
 * one of `ExecCompleted` / `ExecTimeout` / `ExecOOM` / `ExecEgressDenied`
 * / `ExecCrashed` based on `ExecResult.status`. The `:native` path also
 * emits `tool.exec.unsandboxed` at dispatch time and writes a stderr
 * deprecation warning — the gen ran unsandboxed, the trace carries the
 * evidence, the stderr line nudges the author toward a real substrate.
 *
 * No exec policy on ctx means the tool was called without going through
 * the runner's policy wiring (or a gen with no `security exec:` block at
 * all). We refuse rather than silently run native — running arbitrary
 * code without a declared policy is the scenario RED-213 exists to close.
 */
import type { ToolContext } from '../tools/tool-context.js';
import { getSubstrate } from '../exec-substrate/registry.js';
import type { ExecOpts, ExecResult, SubstrateName } from '../exec-substrate/types.js';

type ExecInput = { language: string; code: string };
type ExecOutput = { stdout: string; stderr: string; exit_code: number };

// Dedup the :native stderr warning per-run, not per-process. Each
// `runGen` call builds a fresh `ctx.emitStep` closure — using that
// closure identity as the WeakMap key gives us one-stderr-line-per-run
// regardless of whether the runner lives in a short-lived `cambium run`
// subprocess OR a long-lived engine-mode host (where pid-based dedup
// would miss all runs after the first). WeakMap releases automatically
// when the run completes. The structured `tool.exec.unsandboxed` trace
// event still fires every call; only the stderr line is deduplicated.
// Pre-RED-249 cambium-security finding 2.
const _warnedPerRun = new WeakMap<object, Set<string>>();
const _warnedNoRunCtx = new Set<string>();

function emitNativeDeprecationWarning(toolName: string, emitStep: unknown) {
  let seen: Set<string>;
  if (emitStep) {
    const existing = _warnedPerRun.get(emitStep as object);
    seen = existing ?? new Set<string>();
    if (!existing) _warnedPerRun.set(emitStep as object, seen);
  } else {
    // Direct-tool-call path (unit tests without a runner). Falls back
    // to a process-scoped Set so tests can still observe the warning.
    seen = _warnedNoRunCtx;
  }
  if (seen.has(toolName)) return;
  seen.add(toolName);
  process.stderr.write(
    `WARNING: ${toolName} uses exec runtime :native (no sandbox). ` +
    `Set runtime: :wasm or :firecracker in the gen's \`security exec:\` block to remove this warning.\n`,
  );
}

// Test hook — lets direct-call tests reset the warning set between cases.
// The run-scoped WeakMap dedup self-resets per run; this only clears the
// no-runner fallback set used by unit tests that bypass emitStep.
export function _resetNativeWarningForTests() {
  _warnedNoRunCtx.clear();
}

// Defaults applied when the gen's `security exec:` block omitted a field.
// Conservative — real production caps should be set explicitly by the gen.
const DEFAULTS = {
  cpu: 1,
  memory: 256,
  timeout: 30,
  maxOutputBytes: 50_000,
} as const;

// The DSL's `language:` field accepts 'python' or 'node' (legacy) — the
// substrate interface uses 'python' or 'js'. Map the legacy value through.
function normalizeLanguage(l: string): 'js' | 'python' {
  if (l === 'node' || l === 'js' || l === 'javascript') return 'js';
  if (l === 'python' || l === 'py') return 'python';
  throw new Error(
    `execute_code: unsupported language "${l}". Supported: python, node.`,
  );
}

export async function execute(input: ExecInput, ctx?: ToolContext): Promise<ExecOutput> {
  const { language, code } = input;
  if (!code) throw new Error('execute_code: missing code');

  if (!ctx?.execPolicy) {
    throw new Error(
      'execute_code: no security exec policy available. The gen must declare a ' +
      '`security exec:` block (either legacy `{ allowed: true }` for back-compat ' +
      'or the new `{ runtime: :wasm | :firecracker | :native, ... }` shape).',
    );
  }

  // `allowed: false` means the gen explicitly opted out — even if a
  // runtime is set (which it shouldn't be, but defense in depth), we
  // refuse. Without this guard a gen writing
  // `security exec: { allowed: false }` would silently reach the
  // native substrate via the `runtime ?? 'native'` fallback below.
  if (!ctx.execPolicy.allowed) {
    throw new Error(
      'execute_code: exec is not allowed by the gen security policy ' +
      '(security exec: { allowed: false }). Remove `uses :execute_code` ' +
      'or set `security exec: { allowed: true, runtime: :wasm | ... }`.',
    );
  }

  const runtime = (ctx.execPolicy.runtime ?? 'native') as SubstrateName;
  const substrate = getSubstrate(runtime);

  const opts: ExecOpts = {
    language: normalizeLanguage(language),
    code,
    cpu:            ctx.execPolicy.cpu            ?? DEFAULTS.cpu,
    memory:         ctx.execPolicy.memory         ?? DEFAULTS.memory,
    timeout:        ctx.execPolicy.timeout        ?? DEFAULTS.timeout,
    network:        ctx.execPolicy.network        ?? 'none',
    filesystem:     ctx.execPolicy.filesystem     ?? 'none',
    maxOutputBytes: ctx.execPolicy.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
  };

  // ── RED-249: structured trace events + :native deprecation surface ──

  // :native is the deprecated fig-leaf path. One stderr warning per
  // run (not per call) + a structured trace event on every dispatch
  // so the trace.json can be grepped for unsandboxed execs.
  //
  // Intentional ordering: `tool.exec.unsandboxed` is emitted BEFORE
  // `ExecSpawned` so a trace truncated mid-dispatch still carries the
  // deprecation marker. Flag before spawn is safer than flag after.
  if (runtime === 'native') {
    emitNativeDeprecationWarning(ctx.toolName, ctx.emitStep);
    ctx.emitStep?.({
      type: 'tool.exec.unsandboxed',
      meta: { tool: ctx.toolName, deprecated: true },
    });
  }

  ctx.emitStep?.({
    type: 'ExecSpawned',
    ok: true,
    meta: {
      runtime,
      language: opts.language,
      cpu: opts.cpu,
      memory: opts.memory,
      timeout: opts.timeout,
    },
  });

  const result = await substrate.execute(opts);

  ctx.emitStep?.(stepForResult(runtime, opts, result));

  // Collapse the substrate's structured status into execute_code's
  // existing `{ stdout, stderr, exit_code }` output shape. Non-completed
  // statuses surface as exit_code !== 0 with a reason appended to
  // stderr so the model can see what went wrong (the structured event
  // already landed in trace.steps via `ctx.emitStep` above).
  if (result.status === 'completed') {
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode ?? 0,
    };
  }

  const reasonLine = result.reason ? `\n[${result.status}: ${result.reason}]` : `\n[${result.status}]`;
  return {
    stdout: result.stdout,
    stderr: `${result.stderr}${reasonLine}`,
    exit_code: 1,
  };
}

/** RED-249: map the substrate's `ExecResult.status` onto the matching
 *  trace step type with its pinned meta shape (design note §8). */
function stepForResult(runtime: SubstrateName, opts: ExecOpts, result: ExecResult) {
  const common = {
    runtime,
    language: opts.language,
    duration_ms: result.durationMs,
  };
  switch (result.status) {
    case 'completed':
      return {
        type: 'ExecCompleted',
        ok: (result.exitCode ?? 0) === 0,
        meta: {
          ...common,
          exit_code: result.exitCode ?? 0,
          mem_peak_mb: result.memPeakMb,
          stdout_bytes: Buffer.byteLength(result.stdout, 'utf8'),
          stderr_bytes: Buffer.byteLength(result.stderr, 'utf8'),
          truncated: result.truncated,
        },
      };
    case 'timeout':
      return {
        type: 'ExecTimeout',
        ok: false,
        meta: { ...common, timeout_seconds: opts.timeout, reason: result.reason },
      };
    case 'oom':
      return {
        type: 'ExecOOM',
        ok: false,
        meta: {
          ...common,
          mem_peak_mb: result.memPeakMb,
          memory_limit_mb: opts.memory,
          reason: result.reason,
        },
      };
    case 'egress_denied':
      return {
        type: 'ExecEgressDenied',
        ok: false,
        // `kind` and `target` are substrate-reported via `reason` for now;
        // future substrate impls (WASM in RED-254, Firecracker in RED-251)
        // should populate these directly on ExecResult. For v1 the reason
        // string carries the information.
        meta: { ...common, reason: result.reason },
      };
    case 'crashed':
      return {
        type: 'ExecCrashed',
        ok: false,
        meta: { ...common, reason: result.reason },
      };
  }
}
