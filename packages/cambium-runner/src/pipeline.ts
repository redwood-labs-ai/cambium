/**
 * RED-381 Phase B.1 — Pipeline runtime (sequential `step` operator).
 *
 * Mirrors the shape of `runGenFromIr` for the Pipeline IR. Walks the
 * operators[] array in declaration order, resolves each step's bind()
 * references against the pipeline input + prior step results, compiles
 * the referenced sub-gen on demand via the same Ruby compile path
 * `enrich.ts` uses, and executes via runGen.
 *
 * Phase B.1 scope: `step` only. `fan_out` (Phase C) and `branch_on`
 * (Phase D) throw "not yet implemented" — the IR carries them, but the
 * runtime dispatch lands in those phases. Budget rollup is Phase B.2.
 * Output composition + acceptance gate is Phase B.3.
 *
 * Trace shape: top-level `PipelineRun` with an `operators[]` array; each
 * step lands as a `PipelineStep` whose `trace` field carries the full
 * sub-gen trace (the runGen result's `trace` object) nested unchanged.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGen, type IR, type RunGenResult } from './runner.js';
import { findGenfileDir, resolveGenfileContracts, loadContractsFromGenfile } from './genfile.js';
import { loadAppCorrectors } from './correctors/app-loader.js';
import type { CorrectorFn } from './correctors/types.js';
import {
  builtinLogSinks,
  buildRunLogEvent,
  emitLogEvent,
  classifyRunOutcome,
} from './log/index.js';

// ── Public API ────────────────────────────────────────────────────────

export interface RunPipelineFromIrOptions {
  /** Parsed Pipeline IR (must have `kind: "Pipeline"`). */
  ir: IR;
  /** Working dir for genfile discovery + default artifact root. */
  cwd?: string;
  /** Override trace.json path. Default: `<runDir>/trace.json`. */
  traceOut?: string;
  /** Override output.json path. Default: `<runDir>/output.json`. */
  outputOut?: string;
  /** Pass-through to sub-gen runGen calls. */
  mock?: boolean;
  /** RED-381 Phase F: `schedule:<id>[@<iso_ts>]` indicating this is a
   *  scheduled fire of the pipeline. The id MUST match an entry in
   *  `ir.policies.schedules[]` (typos in cron manifests fail fast at
   *  the CLI, not silently as wrong-bucket behavior later).
   *  Absent → interactive run; trace omits the `fired_by` annotation. */
  firedBy?: string;
  /** RED-381 Phase F: optional log-sink overrides (parallel to
   *  RunGenFromIrOptions.logSinks). Merged over framework built-ins
   *  before emit; host wrappers inject custom backends here. */
  logSinks?: Record<string, any>;
  /** Absolute path to `ruby/cambium/compile.rb`. The pipeline runner
   *  spawns Ruby to compile each sub-gen on demand; that script lives
   *  in the `@redwood-labs/cambium` package, not in the runner. The CLI
   *  computes this from its own location (`cli/cambium.mjs`) and passes
   *  it down so the path doesn't depend on `process.cwd()` — which is
   *  load-bearing for running pipelines from external `[package]`
   *  workspaces. When omitted, the runner attempts a best-effort
   *  resolution from `import.meta.url` (works in-tree + standard
   *  node_modules layouts; throws a clear error if it can't find
   *  compile.rb). */
  compileRb?: string;
}

export interface RunPipelineFromIrResult {
  ok: boolean;
  output: any;
  trace: any;
  runId: string;
  errorMessage?: string;
  /** Typed failure category — 'budget' when the pipeline-level cap
   *  tripped (PipelineBudgetExceeded), 'step_failed' when an
   *  individual sub-gen returned ok:false. Lets CLI / wrapper callers
   *  branch on the kind without string-matching errorMessage. */
  failureKind?: 'budget' | 'step_failed';
  tracePath: string;
  outputPath: string;
  irPath: string;
  runDir: string;
}

/** Per-step token projection for the pipeline-level budget pre-dispatch
 *  check. Falls back to a conservative default when the sub-gen doesn't
 *  declare model.max_tokens. The default is intentionally generous —
 *  the design note's stance is "ceiling, not quota": pre-dispatch
 *  refusal is for catching obvious oversize spend, not fine-tuning. */
const DEFAULT_PROJECTED_STEP_TOKENS = 2000;

/**
 * Symbolic-name regex shared with the rest of the framework (pack names
 * RED-214, memory pool names RED-215, app-corrector basenames RED-275,
 * grounded_in sources RED-283, model alias names RED-237). Used here
 * to validate the `method` value before it's interpolated into the
 * `ruby compile.rb` shell command. The IR is `any`-typed and accepted
 * from external callers via `runPipelineFromIr({ ir })`; a hand-crafted
 * IR with `method: "analyze; rm -rf"` would otherwise execute arbitrary
 * shell on the host. Belt-and-suspenders with `--method "${method}"`
 * quoting at each execSync site.
 */
const METHOD_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

function assertSafeMethodName(method: string, opId: string): void {
  if (!METHOD_NAME_REGEX.test(method)) {
    throw new Error(
      `Pipeline operator '${opId}': method name "${method}" must match ${METHOD_NAME_REGEX}. ` +
        `Method names interpolate into a shell command; non-conforming names are rejected to ` +
        `prevent shell injection from hand-crafted IR.`,
    );
  }
}

/**
 * Best-effort resolution of `ruby/cambium/compile.rb` from this module's
 * location. Used when `runPipelineFromIr` is called without an explicit
 * `compileRb` option. Two known layouts:
 *
 *   1. In-tree development: pipeline.ts (or dist/pipeline.js) at
 *      `<repo>/packages/cambium-runner/{src,dist}/pipeline.{ts,js}`,
 *      compile.rb at `<repo>/ruby/cambium/compile.rb`. Up 3 + path.
 *
 *   2. Production npm install: runner at
 *      `<install>/node_modules/@redwood-labs/cambium-runner/dist/pipeline.js`,
 *      compile.rb shipped by the sibling `@redwood-labs/cambium` package.
 *      Resolve via createRequire(import.meta.url) so the lookup works
 *      with pnpm, yarn workspaces, or any other node_modules layout
 *      that follows the standard resolution algorithm.
 *
 * Returns null when neither candidate exists — caller throws a clear
 * "pass compileRb explicitly" error.
 */
function resolveDefaultCompileRb(): string | null {
  // Production: ask Node to resolve the cambium package's manifest,
  // then walk to `ruby/cambium/compile.rb` next to it. Robust across
  // package-manager layouts; depends only on standard resolution.
  try {
    const req = createRequire(import.meta.url);
    const cambiumPkg = req.resolve('@redwood-labs/cambium/package.json');
    const candidate = resolve(dirname(cambiumPkg), 'ruby/cambium/compile.rb');
    if (existsSync(candidate)) return candidate;
  } catch {
    // Falls through to in-tree dev resolution below.
  }

  // In-tree dev: walk up from this module's location to the repo root.
  // src/pipeline.ts → packages/cambium-runner/src/ → up 3 → repo root.
  // dist/pipeline.js shares the same depth, so the same relative works.
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = resolve(here, '../../..', 'ruby/cambium/compile.rb');
  if (existsSync(dev)) return dev;

  return null;
}

export async function runPipelineFromIr(
  opts: RunPipelineFromIrOptions,
): Promise<RunPipelineFromIrResult> {
  if (opts.ir?.kind !== 'Pipeline') {
    throw new Error(
      `runPipelineFromIr requires a Pipeline IR (got kind=${JSON.stringify(opts.ir?.kind)}). ` +
        `Gen IRs route through runGenFromIr.`,
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const runId = `run_${nowId()}_${Math.random().toString(16).slice(2, 8)}`;

  // ── --fired-by validation (RED-381 Phase F.1) ────────────────────────
  // Mirrors runGen's logic for gens: shape `schedule:<id>[@<iso_ts>]`;
  // id MUST match an entry in ir.policies.schedules[]. Typos in
  // cron manifests fail fast here, not silently as wrong-bucket
  // behavior later.
  let firedBy: { scheduleId: string; timestamp: string; fireId: string } | null = null;
  if (opts.firedBy) {
    const m = String(opts.firedBy).match(
      /^schedule:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(?:@([^\s]{1,64}))?$/,
    );
    if (!m) {
      throw new Error(
        `Invalid --fired-by value: ${JSON.stringify(opts.firedBy)}. ` +
        `Expected shape: schedule:<id>[@<iso_timestamp>].`,
      );
    }
    const scheduleId = m[1];
    const timestamp = m[2] ?? new Date().toISOString();
    const declared: any[] = opts.ir.policies?.schedules ?? [];
    if (declared.length === 0) {
      throw new Error(
        `--fired-by was set but ${opts.ir.entry?.class ?? 'this pipeline'} declares no cron schedules. ` +
        `Either remove --fired-by or declare a \`cron :...\` on the Pipeline class.`,
      );
    }
    const known = declared.find((s) => s.id === scheduleId);
    if (!known) {
      const ids = declared.map((s) => s.id).join(', ');
      throw new Error(
        `--fired-by schedule id "${scheduleId}" is not declared on ${opts.ir.entry?.class ?? 'this pipeline'}. ` +
        `Declared schedules: [${ids}]`,
      );
    }
    firedBy = { scheduleId, timestamp, fireId: `${scheduleId}:${timestamp}` };
  }

  // Pipeline files live at <workspace>/app/pipelines/<name>.pipeline.rb;
  // <workspace> is two levels up. runs/ + contracts both live relative
  // to it. Mirrors runGenFromIr's stance (engine-mode aware, but
  // pipelines are always app-mode in v1 — engine pipelines defer).
  const pipelineFile = resolveSource(opts.ir.entry?.source, cwd);
  const workspaceDir = pipelineFile
    ? dirname(dirname(dirname(pipelineFile)))
    : cwd;

  const runDir = join(workspaceDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  process.stderr.write(
    `[cambium] run ${runId} dir=${runDir} trace=${opts.traceOut ?? join(runDir, 'trace.json')}\n`,
  );

  // ── Resolve compile.rb path ──────────────────────────────────────────
  // Sub-gens are compiled on demand via `ruby compile.rb`. The path
  // must NOT come from process.cwd() — that breaks any pipeline run
  // started from an external `[package]` workspace. CLI callers pass
  // an absolute path explicitly; library callers without one fall
  // through to import.meta.url-anchored resolution.
  const compileRb = opts.compileRb ?? resolveDefaultCompileRb();
  if (!compileRb || !existsSync(compileRb)) {
    throw new Error(
      `Pipeline runner could not locate ruby/cambium/compile.rb. ` +
        `Pass it explicitly via runPipelineFromIr({ compileRb: '/absolute/path' }) ` +
        `or ensure @redwood-labs/cambium is reachable via Node's module resolution.` +
        (opts.compileRb ? ` (Provided path does not exist: ${opts.compileRb})` : ''),
    );
  }

  // ── Load contracts (shared across all sub-gens) ──────────────────────
  // Pipelines are app-mode in v1 — discover contracts via Genfile.toml
  // from the pipeline's workspace, falling back to the in-tree
  // packages/cambium/src/contracts.ts for the framework's own monorepo.
  const genfileDir = findGenfileDir(opts.ir.entry?.source) ?? cwd;
  const genfile = resolveGenfileContracts(genfileDir);
  let contractsMod: Record<string, any>;
  if (genfile) {
    contractsMod = await loadContractsFromGenfile(genfile);
  } else {
    const fallback = pathToFileURL(
      join(cwd, 'packages/cambium/src/contracts.ts'),
    ).href;
    contractsMod = await import(fallback);
  }

  // ── Load app correctors (RED-275, shared across all sub-gens) ────────
  // Pipeline sub-gens all live in the same workspace and share its
  // `app/correctors/`. Load once at the pipeline level rather than
  // per-step (cheap startup cost, no risk of stale registry). Without
  // this load, sub-gens that declare `corrects :foo` for any non-builtin
  // throw "Unknown corrector" at runtime even though the file exists —
  // the single-gen path loads correctors in runGenFromIr, but the
  // pipeline path calls runGen directly and bypassed the load.
  let appCorrectors: Record<string, CorrectorFn> = {};
  if (genfile) {
    const app = await loadAppCorrectors(genfile.genfileDir);
    appCorrectors = app.correctors;
  }

  // ── Parse pipeline inputs ────────────────────────────────────────────
  // Phase B.1: single declared input slot — the CLI `--arg` value (carried
  // through ir.context._pipeline_arg) maps to that one slot. Multi-input
  // pipelines with JSON-object args are a Phase B.3 follow-up.
  const inputSlots: Record<string, any> = parsePipelineInputs(
    opts.ir.input ?? {},
    opts.ir.context?._pipeline_arg ?? '',
  );

  // ── Pipeline-level memory slots (RED-381 Phase E) ────────────────────
  // The pipeline's policies.memory[] declares slots that sub-gens can
  // opt into via `memory :name, scope: :pipeline_run`. The pipeline is
  // authoritative on strategy/embed/keyed_by/retain (matching the named-
  // pool stance of RED-215). Sub-gen dispatch injects this slot config
  // into each sub-gen's matching memory entry before runGen sees it.
  const pipelineMemorySlots: Record<string, any> = {};
  for (const m of (opts.ir.policies?.memory ?? []) as any[]) {
    if (m && m.name) pipelineMemorySlots[m.name] = m;
  }

  // ── Budget cap (RED-381 Phase B.2) ───────────────────────────────────
  // Pipeline-level top cap: { tokens?, tool_calls? }. Enforcement is
  // pre-dispatch for tokens (projected from the next sub-gen's
  // model.max_tokens — a refusal BEFORE spending) and post-step for
  // tool_calls (since per-tool projection is hard until we know which
  // tools the sub-gen will actually invoke). Per the design note:
  // simple ceiling, no implicit splitting, no per-child re-allocation.
  const budgetCap = opts.ir.policies?.budget ?? {};
  const tokenCap = typeof budgetCap.tokens === 'number' ? budgetCap.tokens : undefined;
  const toolCallCap = typeof budgetCap.tool_calls === 'number' ? budgetCap.tool_calls : undefined;

  // ── Trace skeleton ───────────────────────────────────────────────────
  const startedAtMs = Date.now();
  const trace: any = {
    type: 'PipelineRun',
    run_id: runId,
    version: opts.ir.version,
    name: opts.ir.name,
    entry: opts.ir.entry,
    started_at: new Date(startedAtMs).toISOString(),
    operators: [],
    meta: {
      total_tokens: 0,
      total_tool_calls: 0,
      operators_executed: 0,
      budget_cap_tokens: tokenCap,
      budget_cap_tool_calls: toolCallCap,
    },
  };
  if (firedBy) trace.fired_by = opts.firedBy;

  // ── Per-operator results — populated as steps complete; consumed by
  // bind() resolution on later operators. ──────────────────────────────
  const stepResults: Record<string, any> = {};

  // ── Operator dispatch ────────────────────────────────────────────────
  const operators: any[] = opts.ir.operators ?? [];
  const dispatchCtx: DispatchContext = {
    ir: opts.ir,
    pipelineFile,
    workspaceDir,
    inputSlots,
    contractsMod,
    mock: opts.mock ?? false,
    tokenCap,
    toolCallCap,
    topLevelOps: operators,
    pipelineRunId: runId,
    pipelineMemorySlots,
    compileRb,
    appCorrectors,
  };
  const dispatchResult = await dispatchOperatorList(operators, dispatchCtx, stepResults, trace);
  const pipelineOk = dispatchResult.ok;
  const pipelineError = dispatchResult.errorMessage;
  const pipelineFailureKind = dispatchResult.failureKind;

  // ── Output assembly ──────────────────────────────────────────────────
  let output: any = null;
  if (pipelineOk) {
    output = assembleOutput(opts.ir.output, stepResults, inputSlots, operators);
  }

  trace.ok = pipelineOk;
  trace.finished_at = new Date().toISOString();
  if (pipelineError) trace.error = pipelineError;

  // ── Log emission (RED-381 Phase F.2) ─────────────────────────────────
  // Pipeline-level log destinations declared via `log :datadog` on the
  // Pipeline class fire here. Run-level event names follow the same
  // `<snake_class>.<method>.<event>` shape gens use — buildRunLogEvent
  // builds the snake-cased prefix from ir.entry.class (PascalCase
  // pipeline class names → snake_case event prefix).
  //
  // Sink errors never fail the pipeline (LogFailed trace steps absorb).
  // Per-operator step-level events defer; v1 ships run-level only.
  const logDestinations: any[] = opts.ir.policies?.log ?? [];
  if (logDestinations.length > 0) {
    const { event, reason } = classifyPipelineRunOutcome(
      pipelineOk,
      pipelineFailureKind,
      pipelineError,
    );
    const runEvent = buildRunLogEvent({
      genClass: opts.ir.entry?.class ?? opts.ir.name ?? 'Pipeline',
      method: opts.ir.entry?.method ?? 'run',
      event,
      runId,
      ok: pipelineOk,
      durationMs: Date.now() - startedAtMs,
      traceRef: opts.traceOut ?? join(runDir, 'trace.json'),
      reason,
      trace,
      firedBy: firedBy ? 'schedule' : undefined,
    });
    const sinks = { ...builtinLogSinks, ...(opts.logSinks ?? {}) };
    // Emit synchronously — same await pattern runner.ts uses at its
    // three run-outcome sites. LogEmitted / LogFailed steps land in
    // the pipeline trace's flat-step area for trace tooling.
    await emitLogEvent(runEvent, {
      destinations: logDestinations,
      sinks,
      pushStep: (step) => {
        trace.log_events ??= [];
        trace.log_events.push(step);
      },
    });
  }

  // ── Write artifacts ──────────────────────────────────────────────────
  const irPath = join(runDir, 'ir.json');
  const tracePath = opts.traceOut ?? join(runDir, 'trace.json');
  const outputPath = opts.outputOut ?? join(runDir, 'output.json');
  writeFileSync(irPath, JSON.stringify(opts.ir, null, 2));
  writeFileSync(tracePath, JSON.stringify(trace, null, 2));
  writeFileSync(outputPath, JSON.stringify(output ?? null, null, 2));

  return {
    ok: pipelineOk,
    output,
    trace,
    runId,
    errorMessage: pipelineError,
    failureKind: pipelineFailureKind,
    tracePath,
    outputPath,
    irPath,
    runDir,
  };
}

// ── Log helpers (Phase F.2) ──────────────────────────────────────────

/**
 * Pipeline-specific run-outcome classifier. Gens classify via
 * `classifyRunOutcome(finalOk, trace, budgetExceeded)`; pipelines have
 * their own failure shape (failureKind: 'budget' | 'step_failed')
 * which translates to the same event vocabulary the log primitive
 * already speaks.
 */
function classifyPipelineRunOutcome(
  ok: boolean,
  failureKind: 'budget' | 'step_failed' | undefined,
  _error: string | undefined,
): {
  event: 'complete' | 'failed';
  reason?: 'budget_exceeded' | 'validation_failed' | 'error';
} {
  if (ok) return { event: 'complete' };
  if (failureKind === 'budget') return { event: 'failed', reason: 'budget_exceeded' };
  if (failureKind === 'step_failed') return { event: 'failed', reason: 'validation_failed' };
  return { event: 'failed', reason: 'error' };
}

// ── Budget projection ─────────────────────────────────────────────────

/**
 * Estimate the token spend of an upcoming step BEFORE we spawn the
 * sub-gen. Compiles the sub-gen IR (no execution) and reads its
 * `model.max_tokens` declaration; falls back to a default when the
 * sub-gen doesn't declare one. The compile is cheap (~100ms Ruby
 * subprocess) and the IR is cached implicitly by the OS file cache;
 * a richer cache lives in Phase B.2 if profiling shows this matters.
 *
 * Pre-dispatch projection is necessarily conservative — the cap is a
 * ceiling for "don't spend more than X total." Authors who need
 * precision declare `max_tokens` on every sub-gen.
 */
function projectStepTokens(op: any, workspaceDir: string, compileRb: string): number {
  if (op.kind !== 'Step') return DEFAULT_PROJECTED_STEP_TOKENS;
  const genFile = findGenFile(op.gen, workspaceDir);
  if (!genFile) return DEFAULT_PROJECTED_STEP_TOKENS;
  const method = op.method ?? 'analyze';
  // Validate before interpolation. Projection failures are non-fatal
  // (we just fall back to the default); an injection attempt would
  // throw + propagate through the catch below as a refused projection.
  try {
    assertSafeMethodName(method, op.id ?? '<unknown>');
  } catch {
    return DEFAULT_PROJECTED_STEP_TOKENS;
  }
  try {
    const irJson = execSync(
      `ruby "${compileRb}" "${genFile}" --method "${method}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    const ir = JSON.parse(irJson);
    if (typeof ir?.model?.max_tokens === 'number' && ir.model.max_tokens > 0) {
      return ir.model.max_tokens;
    }
    return DEFAULT_PROJECTED_STEP_TOKENS;
  } catch {
    // Projection failures are non-fatal — the actual dispatch will
    // surface the error from runStep with proper context.
    return DEFAULT_PROJECTED_STEP_TOKENS;
  }
}

// ── Operator dispatch loop (shared by top-level + branch_on bodies) ──

interface DispatchContext {
  ir: IR;
  pipelineFile: string | null;
  workspaceDir: string;
  inputSlots: Record<string, any>;
  contractsMod: Record<string, any>;
  mock: boolean;
  tokenCap: number | undefined;
  toolCallCap: number | undefined;
  /** Always the TOP-LEVEL operators[] from the Pipeline IR. Used by
   *  fan_out's findPriorOperatorResult for pass_context, regardless of
   *  whether the fan_out is nested inside a branch_on body. */
  topLevelOps: any[];
  /** RED-381 Phase E: pipeline-shared memory wiring. Pipeline run id
   *  becomes the bucket key for sub-gen :pipeline_run memory; slot map
   *  carries the pipeline-authoritative strategy/embed/keyed_by/retain
   *  that gets injected into each sub-gen's matching memory entry. */
  pipelineRunId: string;
  pipelineMemorySlots: Record<string, any>;
  /** Absolute path to ruby/cambium/compile.rb. Resolved once at the
   *  top of runPipelineFromIr (from opts.compileRb or import.meta.url-
   *  anchored fallback) so per-step compiles don't depend on
   *  process.cwd() — which would break running pipelines from
   *  external `[package]` workspaces. */
  compileRb: string;
  /** RED-275 app correctors discovered from the pipeline's workspace
   *  (`<genfileDir>/app/correctors/`). Loaded once at the pipeline level
   *  and threaded into every sub-gen's runGen call so `corrects :foo`
   *  resolves identically inside a pipeline as it does in a standalone
   *  `cambium run` of the same gen. */
  appCorrectors: Record<string, CorrectorFn>;
}

interface DispatchResult {
  ok: boolean;
  errorMessage?: string;
  failureKind?: 'budget' | 'step_failed';
}

/**
 * Run a sequence of operators in declaration order, mutating stepResults
 * + parentTrace as it goes. Returns ok=false (and the failure details)
 * on the first failure; remaining operators are not dispatched. Used
 * both by the top-level pipeline loop and by branch_on `on`/`default`
 * body dispatch — same semantics in both contexts.
 *
 * Budget checks fire on the SHARED dispatchCtx so the cap is enforced
 * uniformly across the whole pipeline run, even when operators live
 * inside a branch_on body.
 */
async function dispatchOperatorList(
  operators: any[],
  ctx: DispatchContext,
  stepResults: Record<string, any>,
  parentTrace: { operators: any[]; meta: any },
): Promise<DispatchResult> {
  const runStepCtx: RunStepContext = {
    ir: ctx.ir,
    pipelineFile: ctx.pipelineFile,
    workspaceDir: ctx.workspaceDir,
    inputSlots: ctx.inputSlots,
    stepResults,
    contractsMod: ctx.contractsMod,
    mock: ctx.mock,
    pipelineRunId: ctx.pipelineRunId,
    pipelineMemorySlots: ctx.pipelineMemorySlots,
    compileRb: ctx.compileRb,
    appCorrectors: ctx.appCorrectors,
  };

  for (const op of operators) {
    // Pre-dispatch token-budget projection (Step only — fan_out's
    // projection is harder and lands as a follow-up if needed).
    if (ctx.tokenCap !== undefined && op.kind === 'Step') {
      const projected = projectStepTokens(op, ctx.workspaceDir, ctx.compileRb);
      if (parentTrace.meta.total_tokens + projected > ctx.tokenCap) {
        parentTrace.operators.push({
          type: 'PipelineBudgetExceeded',
          id: op.id,
          metric: 'tokens',
          cap: ctx.tokenCap,
          used: parentTrace.meta.total_tokens,
          projected,
        });
        return {
          ok: false,
          failureKind: 'budget',
          errorMessage:
            `Pipeline token budget exceeded before dispatching :${op.id}. ` +
            `Cap: ${ctx.tokenCap}; used so far: ${parentTrace.meta.total_tokens}; ` +
            `projected next step: ${projected}.`,
        };
      }
    }

    try {
      switch (op.kind) {
        case 'Step': {
          const stepTrace = await runStep(op, runStepCtx);
          parentTrace.operators.push(stepTrace.entry);
          parentTrace.meta.total_tokens += stepTrace.tokens;
          parentTrace.meta.total_tool_calls += stepTrace.toolCalls;
          parentTrace.meta.operators_executed += 1;
          if (!stepTrace.ok) {
            return {
              ok: false,
              failureKind: 'step_failed',
              errorMessage: `Pipeline step :${op.id} failed: ${stepTrace.errorMessage ?? 'unknown error'}`,
            };
          }
          stepResults[op.id] = stepTrace.output;
          if (ctx.toolCallCap !== undefined && parentTrace.meta.total_tool_calls > ctx.toolCallCap) {
            parentTrace.operators.push({
              type: 'PipelineBudgetExceeded',
              id: op.id,
              metric: 'tool_calls',
              cap: ctx.toolCallCap,
              used: parentTrace.meta.total_tool_calls,
            });
            return {
              ok: false,
              failureKind: 'budget',
              errorMessage:
                `Pipeline tool-call budget exceeded after :${op.id} completed. ` +
                `Cap: ${ctx.toolCallCap}; used: ${parentTrace.meta.total_tool_calls}.`,
            };
          }
          break;
        }
        case 'FanOut': {
          const fanOutTrace = await runFanOut(op, runStepCtx, ctx.topLevelOps);
          parentTrace.operators.push(fanOutTrace.entry);
          parentTrace.meta.total_tokens += fanOutTrace.tokens;
          parentTrace.meta.total_tool_calls += fanOutTrace.toolCalls;
          parentTrace.meta.operators_executed += 1;
          if (!fanOutTrace.ok) {
            return {
              ok: false,
              failureKind: 'step_failed',
              errorMessage: `Pipeline fan_out :${op.id} failed: ${fanOutTrace.errorMessage ?? 'threshold not met'}`,
            };
          }
          stepResults[op.id] = fanOutTrace.output;
          if (ctx.toolCallCap !== undefined && parentTrace.meta.total_tool_calls > ctx.toolCallCap) {
            parentTrace.operators.push({
              type: 'PipelineBudgetExceeded',
              id: op.id,
              metric: 'tool_calls',
              cap: ctx.toolCallCap,
              used: parentTrace.meta.total_tool_calls,
            });
            return {
              ok: false,
              failureKind: 'budget',
              errorMessage:
                `Pipeline tool-call budget exceeded after fan_out :${op.id}. ` +
                `Cap: ${ctx.toolCallCap}; used: ${parentTrace.meta.total_tool_calls}.`,
            };
          }
          break;
        }
        case 'BranchOn': {
          const brTrace = await runBranchOn(op, ctx, stepResults);
          parentTrace.operators.push(brTrace.entry);
          parentTrace.meta.total_tokens += brTrace.tokens;
          parentTrace.meta.total_tool_calls += brTrace.toolCalls;
          parentTrace.meta.operators_executed += 1;
          if (!brTrace.ok) {
            return {
              ok: false,
              failureKind: brTrace.failureKind ?? 'step_failed',
              errorMessage: `Pipeline branch_on failed: ${brTrace.errorMessage ?? 'unknown error'}`,
            };
          }
          break;
        }
        default:
          throw new Error(
            `Unknown operator kind '${op.kind}' in Pipeline IR (operator :${op.id ?? '?'}).`,
          );
      }
    } catch (err: any) {
      parentTrace.operators.push({
        type: `Pipeline${op.kind ?? 'Operator'}`,
        id: op.id ?? null,
        ok: false,
        error: err?.message ?? String(err),
      });
      return {
        ok: false,
        errorMessage: err?.message ?? String(err),
      };
    }
  }

  return { ok: true };
}

// ── branch_on dispatch (Phase D) ──────────────────────────────────────

interface BranchOnTrace {
  entry: any;
  ok: boolean;
  tokens: number;
  toolCalls: number;
  errorMessage?: string;
  failureKind?: 'budget' | 'step_failed';
}

async function runBranchOn(
  op: any,
  ctx: DispatchContext,
  stepResults: Record<string, any>,
): Promise<BranchOnTrace> {
  const startedAt = new Date().toISOString();

  // Resolve the signal's value. Phase A enforces the signal must be a
  // bind(:step).field ref; we resolve it against current stepResults.
  let signalValue: any;
  try {
    signalValue = resolveBindRef(op.signal, ctx.inputSlots, stepResults);
  } catch (err: any) {
    return {
      entry: {
        type: 'PipelineBranchOn',
        signal: op.signal,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: `branch_on signal resolution failed: ${err?.message ?? err}`,
      },
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `branch_on signal resolution failed: ${err?.message ?? err}`,
    };
  }

  // Match the signal value against the `on :literal, :literal2 do ... end`
  // clauses. Values in the IR are stringified at compile time
  // (compile.rb stamps `values.map(&:to_s)`); coerce the runtime
  // signal value to string for the comparison so Symbol-vs-String
  // mismatches don't cause spurious misses.
  const stringValue = signalValue === null || signalValue === undefined ? '' : String(signalValue);
  let matchedBranch: any = null;
  for (const br of op.branches ?? []) {
    if ((br.values ?? []).map(String).includes(stringValue)) {
      matchedBranch = br;
      break;
    }
  }

  const firedOps: any[] = matchedBranch ? matchedBranch.operators : (op.default ?? []);
  const defaultFired = !matchedBranch;

  // Phase A.3 enforces branch_on must have an explicit default block;
  // by the time we're here, missing-default would be a compile error.
  // Defense-in-depth check: if NEITHER an on clause matches NOR a
  // default block exists, we're in undefined territory — surface a
  // clear runtime error rather than silently no-op.
  if (!matchedBranch && op.default === undefined) {
    return {
      entry: {
        type: 'PipelineBranchOn',
        signal: op.signal,
        signal_value: stringValue,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: `branch_on: no matching on clause for value=${JSON.stringify(stringValue)} and no default block declared.`,
      },
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `branch_on: no match for ${JSON.stringify(stringValue)}`,
    };
  }

  // Build the nested trace + dispatch the matched body's operators.
  // The branch_on trace nests `operators` for the fired branch so a
  // visual renderer can show "this is what ran when severity=critical."
  const nestedTrace = {
    operators: [] as any[],
    meta: {
      total_tokens: 0,
      total_tool_calls: 0,
      operators_executed: 0,
    },
  };
  const nestedResult = await dispatchOperatorList(firedOps, ctx, stepResults, nestedTrace);

  return {
    entry: {
      type: 'PipelineBranchOn',
      signal: op.signal,
      signal_value: stringValue,
      fired_branch: matchedBranch ? matchedBranch.values : null,
      default_fired: defaultFired,
      ok: nestedResult.ok,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      operators: nestedTrace.operators,
      meta: nestedTrace.meta,
      ...(nestedResult.errorMessage ? { error: nestedResult.errorMessage } : {}),
    },
    ok: nestedResult.ok,
    tokens: nestedTrace.meta.total_tokens,
    toolCalls: nestedTrace.meta.total_tool_calls,
    errorMessage: nestedResult.errorMessage,
    failureKind: nestedResult.failureKind,
  };
}

// ── Step dispatch ─────────────────────────────────────────────────────

interface RunStepContext {
  ir: IR;
  pipelineFile: string | null;
  workspaceDir: string;
  inputSlots: Record<string, any>;
  stepResults: Record<string, any>;
  contractsMod: Record<string, any>;
  mock: boolean;
  /** RED-381 Phase E: pipeline-shared memory wiring (passed unchanged
   *  to every sub-gen invocation). */
  pipelineRunId: string;
  pipelineMemorySlots: Record<string, any>;
  /** Absolute path to ruby/cambium/compile.rb (forwarded from
   *  DispatchContext). Used by per-step sub-gen compiles. */
  compileRb: string;
  /** RED-275 app correctors (forwarded from DispatchContext). Passed
   *  to every sub-gen's runGen call. */
  appCorrectors: Record<string, CorrectorFn>;
}

interface StepTrace {
  entry: any;
  ok: boolean;
  output?: any;
  tokens: number;
  toolCalls: number;
  errorMessage?: string;
}

async function runStep(op: any, ctx: RunStepContext): Promise<StepTrace> {
  const startedAt = new Date().toISOString();

  // ── Resolve sub-gen file ─────────────────────────────────────────────
  const genFile = findGenFile(op.gen, ctx.workspaceDir);
  if (!genFile) {
    return {
      entry: {
        type: 'PipelineStep',
        id: op.id,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: `Sub-gen file not found for gen=${op.gen} (looked under app/gens/).`,
      },
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Sub-gen file not found for ${op.gen}`,
    };
  }

  // ── Resolve with: bindings → context values ──────────────────────────
  // Each entry: { param, from: { input | step | literal } }. The param
  // name matches the sub-gen method's parameter name → becomes the
  // context key in the sub-gen's IR.
  const stepContext: Record<string, any> = {};
  for (const entry of op.with ?? []) {
    stepContext[entry.param] = resolveBindRef(entry.from, ctx.inputSlots, ctx.stepResults);
  }

  // ── Compile sub-gen ──────────────────────────────────────────────────
  // Spawn `ruby compile.rb` with the gen file + method. Mirrors
  // enrich.ts's compile-on-demand pattern. The CLI subprocess boundary
  // is unavoidable until the Ruby compiler is in-process (out of scope).
  const method = op.method ?? 'analyze';
  assertSafeMethodName(method, op.id ?? '<unknown>');
  let subIr: any;
  try {
    const irJson = execSync(
      `ruby "${ctx.compileRb}" "${genFile}" --method "${method}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    subIr = JSON.parse(irJson);
  } catch (err: any) {
    return {
      entry: {
        type: 'PipelineStep',
        id: op.id,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: `Failed to compile sub-gen ${op.gen}: ${err?.message ?? err}`,
      },
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Sub-gen compile failed: ${err?.message ?? err}`,
    };
  }

  // ── Inject pipeline-resolved context into the sub-gen IR ─────────────
  // Sub-gen IRs carry `context: { <param>: <value> }`. The compile.rb
  // path stamps the `--arg` value into that single key; for pipeline-
  // driven invocations we override with the bind-resolved values keyed
  // by the with: param names.
  if (Object.keys(stepContext).length > 0) {
    subIr.context = { ...(subIr.context ?? {}), ...stepContext };
  }

  // ── Inject pipeline-authoritative memory slots (RED-381 Phase E) ─────
  // Sub-gen memory decls with scope: :pipeline_run carry only name +
  // reader knobs (compile.rb enforces this). Merge in the pipeline's
  // strategy/embed/keyed_by/retain for each matching slot so the
  // memory planner sees a complete decl.
  injectPipelineMemorySlots(subIr, ctx.pipelineMemorySlots, op.gen);

  // ── Execute sub-gen ──────────────────────────────────────────────────
  let subResult: RunGenResult;
  try {
    subResult = await runGen({
      ir: subIr,
      schemas: ctx.contractsMod,
      mock: ctx.mock,
      // RED-381 Phase E: pipeline-shared memory uses the pipeline's
      // workspace runs dir + the pipeline's run id, so all sub-gens
      // of the same pipeline run hit the same SQLite bucket.
      runsRoot: join(ctx.workspaceDir, 'runs'),
      pipelineRunId: ctx.pipelineRunId,
      // RED-275 app correctors loaded once at pipeline boot; passed
      // here so `corrects :foo` resolves the same inside a pipeline
      // step as it does in a standalone `cambium run`.
      correctors: ctx.appCorrectors,
    });
  } catch (err: any) {
    return {
      entry: {
        type: 'PipelineStep',
        id: op.id,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: `Sub-gen execution threw: ${err?.message ?? err}`,
      },
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Sub-gen execution threw: ${err?.message ?? err}`,
    };
  }

  // ── Aggregate sub-gen usage into pipeline rollup ─────────────────────
  // runGen's trace records token usage at each Generate/Repair step.
  // Pipeline-level meta sums across all sub-gens for budget visibility.
  const tokens = sumTokensFromTrace(subResult.trace);
  const toolCalls = countToolCallsFromTrace(subResult.trace);

  return {
    entry: {
      type: 'PipelineStep',
      id: op.id,
      gen: op.gen,
      method,
      ok: subResult.ok,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      meta: { tokens, tool_calls: toolCalls },
      trace: subResult.trace,
    },
    ok: subResult.ok,
    output: subResult.output,
    tokens,
    toolCalls,
    errorMessage: subResult.errorMessage,
  };
}

// ── Fan-out dispatch (Phase C) ────────────────────────────────────────

interface FanOutTrace {
  entry: any;
  ok: boolean;
  output: any[];         // typed array of branch outputs (undefined for failed branches)
  tokens: number;
  toolCalls: number;
  errorMessage?: string;
}

/**
 * Expanded shape of a single fan_out branch, AFTER homogeneous-sugar
 * expansion. Heterogeneous declarations land directly; homogeneous
 * (`agent + over + as`) get expanded into one virtual branch per `over`
 * value with the value baked into `_context[as]`.
 */
interface ExpandedBranch {
  id: string;
  agent: string;
  method: string;
  /** Per-branch additional context contributed by homogeneous expansion. */
  _context?: Record<string, any>;
}

function expandBranches(op: any): ExpandedBranch[] {
  const heterogeneous: any[] = op.branches ?? [];
  const homogeneous = op._homogeneous;

  // Mutual exclusion: a fan_out shouldn't declare both forms in one
  // call. Heterogeneous wins if both are present; this matches the
  // FanOutDSL stance (you'd reach for one or the other). A future
  // Phase A validator pass can make this a compile error.
  if (heterogeneous.length > 0) {
    return heterogeneous.map((b: any) => ({
      id: String(b.id),
      agent: String(b.agent),
      method: String(b.method ?? 'analyze'),
    }));
  }

  if (homogeneous?.agent && Array.isArray(homogeneous.over) && homogeneous.as) {
    return homogeneous.over.map((value: string) => ({
      id: String(value),
      agent: String(homogeneous.agent),
      method: String(homogeneous.method ?? 'analyze'),
      _context: { [String(homogeneous.as)]: value },
    }));
  }

  return [];
}

/**
 * Locate the operator immediately preceding this fan_out in the
 * pipeline's declaration order. `pass_context` fields are pulled from
 * that operator's result; if no prior operator exists (fan_out is the
 * first operator), pass_context resolves against pipeline input slots
 * instead — same precedence story as bind(:input) shortcuts.
 */
function findPriorOperatorResult(
  op: any,
  operators: any[],
  stepResults: Record<string, any>,
): any {
  const idx = operators.findIndex((o) => o.id === op.id);
  for (let i = idx - 1; i >= 0; i--) {
    const prior = operators[i];
    if (prior.id && prior.id in stepResults) return stepResults[prior.id];
  }
  return null;
}

/**
 * Concurrency-limited worker pool. Native Promise.all has no built-in
 * limiter; this is a tight worker-pool that pulls tasks off a shared
 * index. PromiseSettledResult preserves both success and failure paths
 * so `on_branch_failure :continue` semantics work naturally.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (next < tasks.length) {
          const i = next++;
          try {
            results[i] = { status: 'fulfilled', value: await tasks[i]() };
          } catch (err: any) {
            results[i] = { status: 'rejected', reason: err };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

async function runFanOut(
  op: any,
  ctx: RunStepContext,
  operators: any[],
): Promise<FanOutTrace> {
  const startedAt = new Date().toISOString();
  const branches = expandBranches(op);
  if (branches.length === 0) {
    return {
      entry: {
        type: 'PipelineFanOut',
        id: op.id,
        ok: false,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: 'fan_out declared no branches (neither heterogeneous nor homogeneous form).',
      },
      ok: false,
      output: [],
      tokens: 0,
      toolCalls: 0,
      errorMessage: 'fan_out has no branches',
    };
  }

  // Build the shared pass_context map from the prior operator's output.
  const passContextFields: string[] = op.pass_context ?? [];
  const priorResult = findPriorOperatorResult(op, operators, ctx.stepResults);
  const passContext: Record<string, any> = {};
  for (const field of passContextFields) {
    passContext[field] = priorResult?.[field];
  }

  // Dispatch each branch concurrently up to `concurrency` workers.
  const concurrency = typeof op.concurrency === 'number' ? op.concurrency : branches.length;
  const branchResults = await runWithConcurrency(
    branches.map((branch) => () => runBranch(branch, op, passContext, ctx)),
    concurrency,
  );

  // Apply on_branch_failure + require threshold rules.
  const onFailure: 'continue' | 'fail_fast' = op.on_branch_failure === 'fail_fast' ? 'fail_fast' : 'continue';
  const requireSpec = op.require ?? { kind: 'all' };
  let succeeded = 0;
  let failed = 0;
  for (const r of branchResults) {
    const ok = r.status === 'fulfilled' && r.value.ok;
    if (ok) succeeded++;
    else failed++;
  }

  let thresholdMet: boolean;
  if (requireSpec.kind === 'all') thresholdMet = failed === 0;
  else if (requireSpec.kind === 'at_least') thresholdMet = succeeded >= (requireSpec.n ?? 1);
  else thresholdMet = false;

  // `fail_fast` short-circuits independent of threshold — any single
  // failure fails the fan-out. (Cooperative cancellation of in-flight
  // sibling branches is not v1: a failed branch's siblings have already
  // started in parallel; the fail_fast semantics ensure the next
  // operator never dispatches, which is what observable failure is.)
  const fanOutOk = onFailure === 'fail_fast' ? failed === 0 && thresholdMet : thresholdMet;

  // Collect per-branch results into the typed array. Failed branches
  // contribute `undefined`. The threshold rule above is what determines
  // pipeline-level success; the array is exposed regardless so the
  // downstream consumer can introspect partial coverage.
  const resultArray: any[] = branchResults.map((r) =>
    r.status === 'fulfilled' && r.value.ok ? r.value.output : undefined,
  );

  // Aggregate per-branch token + tool-call usage.
  let totalTokens = 0;
  let totalToolCalls = 0;
  for (const r of branchResults) {
    if (r.status === 'fulfilled') {
      totalTokens += r.value.tokens;
      totalToolCalls += r.value.toolCalls;
    }
  }

  const branchEntries = branchResults.map((r, i) => {
    const branch = branches[i];
    if (r.status === 'fulfilled') {
      return {
        branch_id: branch.id,
        ok: r.value.ok,
        trace: r.value.subTrace,
        ...(r.value.errorMessage ? { error: r.value.errorMessage } : {}),
      };
    }
    return {
      branch_id: branch.id,
      ok: false,
      error: r.reason?.message ?? String(r.reason),
    };
  });

  return {
    entry: {
      type: 'PipelineFanOut',
      id: op.id,
      collect_into: op.collect_into,
      ok: fanOutOk,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      meta: {
        succeeded,
        failed,
        threshold: requireSpec.kind === 'all' ? 'all' : `at_least:${requireSpec.n}`,
        on_branch_failure: onFailure,
      },
      branches: branchEntries,
    },
    ok: fanOutOk,
    output: resultArray,
    tokens: totalTokens,
    toolCalls: totalToolCalls,
    errorMessage: fanOutOk
      ? undefined
      : `Fan-out threshold ${requireSpec.kind === 'all' ? 'all' : `at_least:${requireSpec.n}`} not met ` +
        `(${succeeded}/${branches.length} succeeded${onFailure === 'fail_fast' && failed > 0 ? ', fail_fast' : ''}).`,
  };
}

interface BranchOutcome {
  ok: boolean;
  output?: any;
  tokens: number;
  toolCalls: number;
  subTrace?: any;
  errorMessage?: string;
}

async function runBranch(
  branch: ExpandedBranch,
  fanOutOp: any,
  passContext: Record<string, any>,
  ctx: RunStepContext,
): Promise<BranchOutcome> {
  const genFile = findGenFile(branch.agent, ctx.workspaceDir);
  if (!genFile) {
    return {
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Sub-gen file not found for branch agent ${branch.agent}`,
    };
  }

  // Compile sub-gen IR (same pattern as runStep).
  const branchMethod = branch.method ?? 'analyze';
  assertSafeMethodName(branchMethod, branch.id ?? '<unknown>');
  let subIr: any;
  try {
    const irJson = execSync(
      `ruby "${ctx.compileRb}" "${genFile}" --method "${branchMethod}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    subIr = JSON.parse(irJson);
  } catch (err: any) {
    return {
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Sub-gen compile failed for branch ${branch.id}: ${err?.message ?? err}`,
    };
  }

  // Merge pass_context (from the prior step) + per-branch context
  // (from homogeneous sugar's `as: :slot`) into the sub-gen's IR
  // context. Both layers contribute, with branch-specific context
  // winning on conflict.
  const branchContext = { ...passContext, ...(branch._context ?? {}) };
  if (Object.keys(branchContext).length > 0) {
    subIr.context = { ...(subIr.context ?? {}), ...branchContext };
  }

  // RED-381 Phase E: same slot-injection step as runStep — the parallel
  // dispatch path needs identical memory wiring so every branch sees
  // the shared pipeline-run bucket via its declared :pipeline_run scope.
  injectPipelineMemorySlots(subIr, ctx.pipelineMemorySlots, branch.agent);

  let subResult: RunGenResult;
  try {
    subResult = await runGen({
      ir: subIr,
      schemas: ctx.contractsMod,
      mock: ctx.mock,
      runsRoot: join(ctx.workspaceDir, 'runs'),
      pipelineRunId: ctx.pipelineRunId,
      correctors: ctx.appCorrectors,
    });
  } catch (err: any) {
    return {
      ok: false,
      tokens: 0,
      toolCalls: 0,
      errorMessage: `Branch ${branch.id} threw during execution: ${err?.message ?? err}`,
    };
  }

  const tokens = sumTokensFromTrace(subResult.trace);
  const toolCalls = countToolCallsFromTrace(subResult.trace);

  return {
    ok: subResult.ok,
    output: subResult.output,
    tokens,
    toolCalls,
    subTrace: subResult.trace,
    errorMessage: subResult.errorMessage,
  };
}

// ── Pipeline memory slot injection (Phase E) ──────────────────────────

/**
 * RED-381 Phase E: merge pipeline-authoritative slot config into sub-gen
 * memory entries.
 *
 * A sub-gen declares `memory :findings, scope: :pipeline_run, top_k: 5`;
 * its IR carries `{ name: 'findings', scope: 'pipeline_run', top_k: 5 }`
 * — no strategy/embed/keyed_by/retain (the gen-side compile.rb path
 * rejects those on :pipeline_run scope). The pipeline's matching slot
 * carries the authoritative shape: `{ name: 'findings', scope:
 * 'pipeline_run', strategy: 'semantic', embed: 'omlx:bge-small-en', ... }`.
 *
 * Injection rules:
 *   - For each sub-gen memory entry with scope === 'pipeline_run':
 *     - Look up the pipeline's slot by name.
 *     - If not found → throw a clear error (gen declares a slot the
 *       pipeline never declared; either fix the gen or add the slot).
 *     - Merge pipeline-authoritative slots into the sub-gen entry.
 *       Sub-gen's reader knobs (size, top_k) win on conflict — the
 *       gen-side can tighten the read window without contradicting
 *       the pipeline's strategy choice.
 */
function injectPipelineMemorySlots(
  subIr: any,
  pipelineSlots: Record<string, any>,
  agentName: string,
): void {
  const memDecls = subIr?.policies?.memory;
  if (!Array.isArray(memDecls) || memDecls.length === 0) return;

  const PIPELINE_AUTHORITATIVE = ['strategy', 'embed', 'keyed_by', 'retain'] as const;

  for (let i = 0; i < memDecls.length; i++) {
    const decl = memDecls[i];
    if (decl?.scope !== 'pipeline_run') continue;

    const slot = pipelineSlots[decl.name];
    if (!slot) {
      throw new Error(
        `Sub-gen ${agentName} declares memory '${decl.name}' with scope: :pipeline_run, ` +
          `but the pipeline didn't declare a matching slot. Add ` +
          `\`memory :${decl.name}, strategy: :<strat>, ...\` to the pipeline class, ` +
          `or remove the gen-side declaration.`,
      );
    }

    const merged = { ...decl };
    for (const field of PIPELINE_AUTHORITATIVE) {
      if (slot[field] !== undefined && merged[field] === undefined) {
        merged[field] = slot[field];
      }
    }
    memDecls[i] = merged;
  }
}

// ── Bind() ref resolution ─────────────────────────────────────────────

function resolveBindRef(
  ref: any,
  inputSlots: Record<string, any>,
  stepResults: Record<string, any>,
): any {
  if (ref == null) return undefined;

  if ('literal' in ref) return ref.literal;

  if ('input' in ref) {
    // bind(:input) (no chained field) — only valid when the pipeline
    // declares exactly one input slot; returns that slot's value.
    if (ref.input === true) {
      const keys = Object.keys(inputSlots);
      if (keys.length === 1) return inputSlots[keys[0]];
      throw new Error(
        `bind(:input) is ambiguous: pipeline declares ${keys.length} input slots — ` +
          `use bind(:input).<slot_name> to disambiguate.`,
      );
    }
    return inputSlots[ref.input];
  }

  if ('step' in ref) {
    const result = stepResults[ref.step];
    if (result === undefined) {
      throw new Error(
        `bind(:${ref.step}) references step that hasn't produced a result yet ` +
          `(operator ordering bug or unsupported operator on prior step).`,
      );
    }
    if (!ref.field) return result;
    return getNestedValue(result, ref.field);
  }

  throw new Error(`Unknown bind ref shape: ${JSON.stringify(ref)}`);
}

function getNestedValue(obj: any, path: string): any {
  if (obj == null) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ── Output assembly ───────────────────────────────────────────────────

function assembleOutput(
  outputSpec: any,
  stepResults: Record<string, any>,
  inputSlots: Record<string, any>,
  operators: any[],
): any {
  if (!outputSpec || outputSpec.kind === 'last_step') {
    // Last operator with a recorded result wins. fan_out / branch_on
    // results aren't recorded in stepResults until Phase C / D.
    const ids = Object.keys(stepResults);
    if (ids.length === 0) return null;
    // Iterate operators in declaration order to find the LAST step that
    // produced a recorded result (so a failed terminal operator falls
    // back to the most recent successful one).
    let last: any = null;
    for (const op of operators) {
      if (op.id && op.id in stepResults) last = stepResults[op.id];
    }
    return last;
  }

  if (outputSpec.kind === 'compose') {
    // Output composition can reference step outputs AND pipeline inputs
    // (matching the design note's stance — output is logically last;
    // any declared value is in scope). Compile-time validation
    // already enforces shape; this just resolves the refs.
    const out: Record<string, any> = {};
    for (const field of outputSpec.fields ?? []) {
      out[field.name] = resolveBindRef(field.from, inputSlots, stepResults);
    }
    return out;
  }

  throw new Error(`Unknown output kind: ${JSON.stringify(outputSpec.kind)}`);
}

// ── Pipeline input parsing ────────────────────────────────────────────

function parsePipelineInputs(
  declared: Record<string, { schema: string }>,
  rawArg: string,
): Record<string, any> {
  const slotNames = Object.keys(declared);
  if (slotNames.length === 0) return {};

  // Single slot: rawArg goes there as a string (downstream gens parse
  // JSON themselves if they declare structured input). Matches
  // gen-side `--arg` semantics.
  if (slotNames.length === 1) {
    return { [slotNames[0]]: rawArg };
  }

  // Multi-slot: rawArg MUST be a JSON object with keys matching the
  // declared slots. Phase B.1 supports this minimally — anything more
  // ergonomic (per-slot CLI flags, etc.) is a CLI follow-up.
  try {
    const parsed = JSON.parse(rawArg);
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      throw new Error('Multi-input pipelines require JSON-object --arg.');
    }
    const out: Record<string, any> = {};
    for (const slot of slotNames) out[slot] = parsed[slot];
    return out;
  } catch (e: any) {
    throw new Error(
      `Pipeline declares ${slotNames.length} input slots (${slotNames.join(', ')}) — ` +
        `--arg must be a JSON object mapping slot names to values. ${e.message ?? ''}`,
    );
  }
}

// ── Sub-gen file resolution ───────────────────────────────────────────

function classNameToSnake(className: string): string {
  return className.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function findGenFile(className: string, workspaceDir: string): string | null {
  const snake = classNameToSnake(className);
  const lower = className.toLowerCase();
  const candidates = [
    join(workspaceDir, 'app', 'gens', `${snake}.cmb.rb`),
    join(workspaceDir, 'app', 'gens', `${lower}.cmb.rb`),
    // Framework default — matches enrich.ts's fallback.
    join('packages', 'cambium', 'app', 'gens', `${snake}.cmb.rb`),
    join('packages', 'cambium', 'app', 'gens', `${lower}.cmb.rb`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ── Sub-gen trace aggregation helpers ─────────────────────────────────

function sumTokensFromTrace(trace: any): number {
  if (!trace?.steps) return 0;
  let total = 0;
  for (const s of trace.steps) {
    const usage = s?.meta?.usage;
    if (usage?.total_tokens) total += usage.total_tokens;
  }
  return total;
}

function countToolCallsFromTrace(trace: any): number {
  if (!trace?.steps) return 0;
  return trace.steps.filter((s: any) => s?.type === 'ToolCall').length;
}

// ── Utility ───────────────────────────────────────────────────────────

function nowId(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

function resolveSource(source: string | undefined, cwd: string): string | null {
  if (!source) return null;
  const abs = resolve(cwd, source);
  return existsSync(abs) ? abs : null;
}
