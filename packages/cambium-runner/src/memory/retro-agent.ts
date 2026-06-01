import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import type { SqliteMemoryBackend } from './backend.js';

// Anchor workspace-relative lookups to this module's location instead
// of process.cwd(). The workspace root is five dirs up from
// packages/cambium-runner/src/memory/retro-agent.ts, so resolution works
// regardless of the cwd `cambium run` was invoked from (CI, Docker,
// subdirectory…). RED-242 moved this file from src/memory/ to
// packages/cambium-runner/src/memory/, so the climb is two dirs deeper
// than the original.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(MODULE_DIR, '..', '..', '..', '..');

/**
 * RED-380: Resolve the `cli/cambium.mjs` path. Mirrors the precedence
 * chain established by RED-376 (`resolveDefaultCompileRb`) so the retro
 * subprocess no longer depends on `process.cwd()` being the monorepo
 * root. Precedence, highest first:
 *
 *   1. Explicit `override` (caller/test override — `opts.cambiumCli`).
 *
 *   2. `CAMBIUM_CLI` env var (operator escape hatch for non-standard
 *      install layouts where `@redwood-labs/cambium` isn't resolvable
 *      from the runner's module location — e.g. strict-pnpm trees,
 *      symlinked CLIs).
 *
 *   3. Production npm install: runner at
 *      `<install>/node_modules/@redwood-labs/cambium-runner/dist/memory/retro-agent.js`,
 *      CLI at the sibling `@redwood-labs/cambium` package's `cli/cambium.mjs`.
 *      Resolve via createRequire(import.meta.url) so the lookup works
 *      with pnpm, yarn workspaces, or any other node_modules layout
 *      that follows the standard resolution algorithm.
 *
 *   4. In-tree development / monorepo fallback: retro-agent at
 *      `<repo>/packages/cambium-runner/{src,dist}/memory/retro-agent.{ts,js}`,
 *      CLI at `<repo>/cli/cambium.mjs`. Walk up from MODULE_DIR to the
 *      `<repo>/packages/cambium-runner` level, then one more to repo root.
 *
 * The explicit `override` and `CAMBIUM_CLI` links return as-is (no
 * existence gate): an operator/test asserting a path should surface its
 * own spawn error rather than silently falling back to a different CLI.
 * Returns null when none of links 1–4 resolve — caller returns a clear
 * "pass cliPath / set CAMBIUM_CLI" error.
 */
export function resolveDefaultCli(override?: string): string | null {
  // 1. Explicit caller override (tests, embedding hosts) wins outright.
  if (override && override.trim()) return override;

  // 2. Operator escape hatch.
  const envCli = process.env.CAMBIUM_CLI;
  if (envCli && envCli.trim()) return envCli;

  // 3. Production: ask Node to resolve the cambium package's manifest,
  //    then walk to `cli/cambium.mjs` next to it.
  try {
    const req = createRequire(import.meta.url);
    const cambiumPkg = req.resolve('@redwood-labs/cambium/package.json');
    const candidate = resolve(dirname(cambiumPkg), 'cli/cambium.mjs');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Falls through to in-tree dev resolution below.
  }

  // 4. In-tree dev: walk up from this module's location to the repo root.
  // retro-agent.ts → packages/cambium-runner/src/memory/ → up 4 → repo root.
  const dev = resolve(MODULE_DIR, '..', '..', '..', '..', 'cli/cambium.mjs');
  if (existsSync(dev)) return dev;

  return null;
}

/**
 * RED-215 phase 4: retro memory-agent dispatch.
 *
 * After a primary gen completes successfully with `write_memory_via
 * :SomeAgent` declared, the primary runner spawns the agent as a
 * separate `cambium run` subprocess, hands it a JSON context describing
 * the run, and applies the structured writes returned from its
 * `MemoryWrites` output to the primary's still-open backends.
 *
 * Invariants:
 *   - Agent failures are best-effort: traced, never propagated to the
 *     primary. The primary already returned a valid answer; memory is
 *     graceful degradation.
 *   - Agent-originated writes land tagged as `agent:<ClassName>` so
 *     `written_by` stays useful for audit.
 *   - Writes naming a memory slot not declared on the primary are
 *     dropped (not applied) and counted in trace.dropped[].
 *
 * The `remember` method name is Cambium's ActiveJob#perform — a
 * convention-over-configuration entry point that the framework always
 * invokes. Don't make this configurable.
 */

/** CamelCase class name → snake_case file base. `SupportMemoryAgent` → `support_memory_agent`. */
export function classNameToFileBase(className: string): string {
  return className.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Find the .cmb.rb file for a memory-agent class name. Search order:
 *  1. `<primary's package>/app/gens/<snake>.cmb.rb`  (sibling of primary)
 *  2. `<workspaceRoot>/packages/cambium/app/gens/<snake>.cmb.rb`
 *
 * The workspace fallback is anchored at `WORKSPACE_ROOT` (derived from
 * `import.meta.url`) instead of `process.cwd()` — that way a `cambium
 * run` invoked from a subdirectory or a non-workspace cwd still
 * resolves the in-tree reference agents.
 */
export function findRetroAgentFile(
  className: string,
  primarySourceFile: string | undefined,
): string | null {
  const base = classNameToFileBase(className);
  const candidates: string[] = [];

  if (primarySourceFile) {
    // primary is at <pkg>/app/gens/<name>.cmb.rb, so siblings share the gens dir
    candidates.push(join(dirname(primarySourceFile), `${base}.cmb.rb`));
  }
  candidates.push(join(WORKSPACE_ROOT, 'packages', 'cambium', 'app', 'gens', `${base}.cmb.rb`));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Build the JSON payload the memory agent receives via --arg. */
export function buildRetroContext(input: string, output: unknown, trace: unknown): string {
  return JSON.stringify({
    primary_input: input,
    primary_output: output,
    primary_trace: trace,
  });
}

export type RetroResult =
  | { ok: true; writes: Array<{ memory: string; content: string }>; agentTracePath: string }
  | { ok: false; reason: string; stderr?: string };

/**
 * Invoke the retro agent as a subprocess. Returns a tagged union so
 * callers can trace the failure without a try/catch shape.
 *
 * `mockMode` is mirrored from the primary run: in tests the primary
 * runs with --mock, and the retro agent must also run with --mock so
 * it doesn't try to hit a real model backend. mockGenerate is
 * schema-aware and emits a valid `MemoryWrites` shape when the IR's
 * returnSchemaId is MemoryWrites.
 */
export function invokeRetroAgent(args: {
  agentFile: string;
  ctx: string;
  mockMode: boolean;
  /** RED-380: optional explicit `cli/cambium.mjs` path. Highest-priority
   *  link in the resolution chain — used by tests and embedding hosts
   *  that know the CLI location. Falls back to `CAMBIUM_CLI` env, then
   *  module-location resolution. See {@link resolveDefaultCli}. */
  cambiumCli?: string;
}): RetroResult {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-retro-'));
  const ctxFile = join(dir, 'ctx.json');
  const outFile = join(dir, 'agent_out.json');
  const traceFile = join(dir, 'agent_trace.json');
  writeFileSync(ctxFile, args.ctx);

  const flags = [
    'run',
    args.agentFile,
    '--method', 'remember',
    '--arg', ctxFile,
    '--out', outFile,
    '--trace', traceFile,
  ];
  if (args.mockMode) flags.push('--mock');

  // RED-380: resolve the CLI path from this module's location instead
  // of relying on process.cwd(). When called from an engine-mode host
  // or any consumer where cwd isn't the cambium monorepo root, the
  // hardcoded 'cli/cambium.mjs' path silently fails with ENOENT.
  const cliPath = resolveDefaultCli(args.cambiumCli);
  if (!cliPath) {
    return {
      ok: false,
      reason:
        'retro-agent could not locate cli/cambium.mjs. Ensure @redwood-labs/cambium ' +
        'is installed alongside @redwood-labs/cambium-runner, set CAMBIUM_CLI to its ' +
        'path, or run from the monorepo root.',
    };
  }

  const result = spawnSync('node', [cliPath, ...flags], {
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      reason: `retro agent exited with status ${result.status}`,
      stderr: result.stderr ?? '',
    };
  }

  try {
    const output = JSON.parse(readFileSync(outFile, 'utf8'));
    const writes = output?.writes;
    if (!Array.isArray(writes)) {
      return { ok: false, reason: `retro agent output missing writes[] (got ${typeof writes})` };
    }
    return { ok: true, writes, agentTracePath: traceFile };
  } catch (e: any) {
    return { ok: false, reason: `failed to parse agent output: ${e?.message ?? e}` };
  }
}

/** Max bytes of content a single retro-agent write can append. Protects
 *  against a compromised / prompt-injected agent flooding a memory
 *  bucket with megabytes of junk (DoS + blowing up future prompts). */
export const MAX_RETRO_CONTENT_BYTES = 2000;

/**
 * Apply the agent's write list to the primary's open backends. Writes
 * naming a memory slot the primary doesn't declare are dropped —
 * counted in the return value so the trace can surface them, but not
 * an error. `written_by` is tagged `agent:<ClassName>` for auditability.
 *
 * Every write's content is sanitized before being appended:
 *   - truncated to MAX_RETRO_CONTENT_BYTES (2 KB) — defense against
 *     prompt-injected agents trying to flood memory
 *   - control characters (0x00–0x1F, 0x7F) stripped — defense against
 *     entries that break the prompt-block injector's newline-collapse
 *     guard with uncommon whitespace
 *
 * This is an inline sanitizer, not a shaping tool — we do NOT try to
 * detect "jailbreak attempts" in the content, only blunt the impact of
 * any that slip through.
 */
export function applyRetroWrites(
  writes: Array<{ memory: string; content: string }>,
  backends: Map<string, SqliteMemoryBackend>,
  agentClassName: string,
): {
  applied: Array<{ memory: string; entry_id: number; bytes: number; truncated: boolean }>;
  dropped: Array<{ memory: string; reason: string }>;
} {
  const applied: Array<{ memory: string; entry_id: number; bytes: number; truncated: boolean }> = [];
  const dropped: Array<{ memory: string; reason: string }> = [];
  const writtenBy = `agent:${agentClassName}`;

  for (const w of writes) {
    if (!w || typeof w.memory !== 'string' || typeof w.content !== 'string') {
      dropped.push({ memory: String(w?.memory ?? '<invalid>'), reason: 'malformed entry' });
      continue;
    }
    const backend = backends.get(w.memory);
    if (!backend) {
      dropped.push({ memory: w.memory, reason: 'no matching memory decl on primary' });
      continue;
    }
    const { content, truncated } = sanitizeRetroContent(w.content);
    const { id, bytes } = backend.append(content, writtenBy);
    applied.push({ memory: w.memory, entry_id: id, bytes, truncated });
  }

  return { applied, dropped };
}

export function sanitizeRetroContent(raw: string): { content: string; truncated: boolean } {
  // Strip C0 + DEL control chars; preserve newlines so stored content
  // still reads like the agent wrote it (phase 3's prompt-block newline-
  // collapse handles header-injection at read time — we don't double-
  // sanitize here).
  const stripped = raw.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const buf = Buffer.from(stripped, 'utf8');
  if (buf.byteLength <= MAX_RETRO_CONTENT_BYTES) {
    return { content: stripped, truncated: false };
  }
  // Truncate at UTF-8 boundary to avoid leaving a half-codepoint at the end.
  const truncated = buf.subarray(0, MAX_RETRO_CONTENT_BYTES).toString('utf8');
  return { content: truncated + '…', truncated: true };
}
