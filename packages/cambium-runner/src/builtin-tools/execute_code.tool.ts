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
 * No exec policy on ctx means the tool was called without going through
 * the runner's policy wiring (or a gen with no `security exec:` block at
 * all). We refuse rather than silently run native — running arbitrary
 * code without a declared policy is the scenario RED-213 exists to close.
 */
import type { ToolContext } from '../tools/tool-context.js';
import { getSubstrate } from '../exec-substrate/registry.js';
import type { ExecOpts } from '../exec-substrate/types.js';

type ExecInput = { language: string; code: string };
type ExecOutput = { stdout: string; stderr: string; exit_code: number };

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

  const runtime = ctx.execPolicy.runtime ?? 'native';
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

  const result = await substrate.execute(opts);

  // Collapse the substrate's structured status into execute_code's
  // existing `{ stdout, stderr, exit_code }` output shape. Non-completed
  // statuses surface as exit_code !== 0 with a reason appended to
  // stderr so the model can see what went wrong. RED-249 adds the
  // structured trace-event emission above this layer.
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
