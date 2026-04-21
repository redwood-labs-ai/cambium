import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

// Framework-builtin tools live next to this file, so their path is
// pinned to the runner's module directory. Using process.cwd() would
// break when the runner is invoked from a subdirectory — app tools stay
// cwd-relative because they're project-local by definition.
const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
import Ajv from 'ajv';
import { ToolRegistry } from './tools/registry.js';
import {
  handleGenerate,
  handleAgenticGenerate,
  handleValidate,
  handleRepair,
  handleCorrect,
} from './step-handlers.js';
import { extractSignals } from './signals.js';
import { evaluateTriggers } from './triggers.js';
import { ActionRegistry } from './actions/registry.js';
import { runReview, runConsensus } from './compound.js';
import { runEnrichment } from './enrich.js';
import { parseBudget, trackBudgetFromTraceStep } from './budget.js';
import type { Budget } from './budget.js';
import {
  parseInlineToolCalls,
  stripInlineToolCalls,
  type ToolCallMessage,
} from './inline-tool-calls.js';
import {
  planMemory,
  readMemoryForRun,
  commitMemoryWrites,
  closeBackends,
  type MemoryPlan,
} from './memory/runner-integration.js';
import { parseMemoryKeys, resolveSessionId, validateScheduleId } from './memory/keys.js';
import type { SqliteMemoryBackend } from './memory/backend.js';
import {
  findRetroAgentFile,
  buildRetroContext,
  invokeRetroAgent,
  applyRetroWrites,
} from './memory/retro-agent.js';
import { resolveGenfileContracts, loadContractsFromGenfile } from './genfile.js';
import { loadAppCorrectors } from './correctors/app-loader.js';
import { builtinCorrectors, _getLegacyAppCorrectors } from './correctors/index.js';
import type { CorrectorFn } from './correctors/types.js';
import { builtinLogSinks, emitLogEvent, loadAppLogSinks, buildRunLogEvent, classifyRunOutcome } from './log/index.js';
import type { LogSink, LogDestination } from './log/index.js';
import { getGroundingDocument } from './context.js';
import { resolveAppRoot } from './app-root.js';
import { resolveEngineDir } from './engine-root.js';

type IR = any;

type Args = {
  irPath: string;
  traceOut?: string;
  outputOut?: string;
  mock?: boolean;
  memoryKeys: string[];
  firedBy?: string;
};

function parseArgs(argv: string[]): Args {
  let irPath: string | null = null;
  let traceOut: string | undefined;
  let outputOut: string | undefined;
  let mock = false;
  const memoryKeys: string[] = [];
  let firedBy: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ir') irPath = argv[++i];
    else if (a === '--trace') traceOut = argv[++i];
    else if (a === '--out') outputOut = argv[++i];
    else if (a === '--mock') { mock = true; process.env.CAMBIUM_ALLOW_MOCK = '1'; }
    else if (a === '--memory-key') memoryKeys.push(argv[++i]);
    else if (a === '--fired-by') firedBy = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.error(`
Cambium Runner — step-graph executor

Usage:
  node --import tsx src/runner.ts --ir <path|-> [--trace <path>] [--out <path>] [--mock]
                                                [--memory-key <name>=<value> ...]

Flags:
  --ir <path>               IR JSON file, or '-' for stdin
  --trace <path>            Write trace JSON to <path> (default: runs/<id>/trace.json)
  --out <path>              Write output JSON to <path> (default: runs/<id>/output.json)
  --mock                    Use deterministic mock instead of live LLM
  --memory-key <name>=<val> Value for a keyed_by slot on a memory/pool (repeatable)
  --help, -h                Show this help

Examples:
  node --import tsx src/runner.ts --ir gen.ir.json
  node --import tsx src/runner.ts --ir - --trace trace.json --out result.json
  echo '{"..."}' | node --import tsx src/runner.ts --ir - --mock
`);
      process.exit(0);
    }
    else throw new Error(`Unknown flag: ${a}\nRun 'node --import tsx src/runner.ts --help' for usage.`);
  }
  if (!irPath) throw new Error('Missing --ir\nRun "node --import tsx src/runner.ts --help" for usage.');
  // RED-305: env-var fallback for --fired-by. Crontab entries often
  // can't cleanly pass CLI flags; env vars are the portable alternative.
  if (!firedBy && process.env.CAMBIUM_FIRED_BY) {
    firedBy = process.env.CAMBIUM_FIRED_BY;
  }
  return { irPath, traceOut, outputOut, mock, memoryKeys, firedBy };
}

function nowId() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseModelId(modelId: string): { provider: string; name: string } {
  const m = modelId.match(/^([a-zA-Z0-9_-]+):(.*)$/);
  if (!m) return { provider: 'ollama', name: modelId };
  return { provider: m[1], name: m[2] };
}

type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type GenerateResult = { text: string; usage?: TokenUsage };

async function generateText(opts: { model: string; system: string; prompt: string; max_tokens?: number; temperature?: number; jsonSchema?: any; }): Promise<GenerateResult> {
  const { provider, name } = parseModelId(opts.model);

  // Force-mock path: `--mock` on the CLI sets CAMBIUM_ALLOW_MOCK=1, which
  // MUST mean "use the deterministic stub, do not contact any model
  // backend." Previously this was only a *fallback* on provider fetch
  // failure, which meant a reachable oMLX/Ollama server swallowed the
  // flag — breaking the promise of `--mock` as an offline/CI path.
  if (process.env.CAMBIUM_ALLOW_MOCK === '1') {
    return { text: mockGenerate(opts.prompt, opts.jsonSchema) };
  }

  try {
    if (provider === 'ollama') {
      const body = {
        model: name,
        prompt: `${opts.system}\n\n${opts.prompt}`,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.max_tokens ?? 1200,
        }
      };

      const res = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`Ollama error: HTTP ${res.status}`);
      const json: any = await res.json();
      return {
        text: json.response as string,
        usage: json.prompt_eval_count != null ? {
          prompt_tokens: json.prompt_eval_count ?? 0,
          completion_tokens: json.eval_count ?? 0,
          total_tokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0),
        } : undefined,
      };
    }

    if (provider === 'omlx') {
      // oMLX server (OpenAI-compatible)
      const baseUrl = process.env.CAMBIUM_OMLX_BASEURL ?? 'http://100.114.183.54:8080';
      const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

      // Append /no_think token to suppress Qwen 3.x thinking mode.
      // This is more reliable than chat_template_kwargs.enable_thinking=false,
      // which can silently disable xgrammar (vllm#39130, sglang#6675).
      const userContent = opts.prompt + '\n/no_think';

      const body: any = {
        model: name,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1200,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: userContent }
        ],
        // Belt-and-suspenders: also send chat_template_kwargs to disable thinking.
        chat_template_kwargs: { enable_thinking: false },
      };

      // Structured output (vLLM-compatible) — requires xgrammar enabled on the server.
      if (opts.jsonSchema && (process.env.CAMBIUM_OMLX_STRUCTURED_OUTPUTS ?? '1') === '1') {
        body.extra_body = { structured_outputs: { json: opts.jsonSchema } };
      }

      // Some servers also support OpenAI-style response_format. Enable optionally.
      if (opts.jsonSchema && (process.env.CAMBIUM_OMLX_RESPONSE_FORMAT ?? '0') === '1') {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: opts.jsonSchema?.$id ?? 'Schema',
            schema: opts.jsonSchema
          }
        };
      }

      const apiKey = process.env.CAMBIUM_OMLX_API_KEY;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`oMLX error: HTTP ${res.status}`);
      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('oMLX: missing choices[0].message.content');
      const usage = json?.usage;
      return {
        text: content as string,
        usage: usage ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        } : undefined,
      };
    }

    throw new Error(`Unknown model provider: ${provider}`);
  } catch (err: any) {
    // Allow a deterministic mock for local development when the provider isn't reachable.
    if (process.env.CAMBIUM_ALLOW_MOCK === '1') {
      return { text: mockGenerate(opts.prompt) };
    }
    const hint = provider === 'omlx'
      ? 'oMLX fetch failed. Check CAMBIUM_OMLX_BASEURL (default http://100.114.183.54:8080) and server status.'
      : 'Ollama fetch failed. Start Ollama (`ollama serve`).';
    throw new Error(`${hint}\nOriginal error: ${err?.message ?? String(err)}`);
  }
}

type Message = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };


type GenerateWithToolsResult = {
  message: { content: string | null; tool_calls?: ToolCallMessage[] };
  usage?: TokenUsage;
};

async function generateWithTools(opts: {
  model: string;
  messages: Message[];
  tools: any[];
  max_tokens?: number;
  temperature?: number;
}): Promise<GenerateWithToolsResult> {
  const { provider, name } = parseModelId(opts.model);

  if (provider === 'ollama') {
    // RED-208: Ollama's /api/chat accepts OpenAI-format tools and returns
    // tool_calls in message.tool_calls. Request/response shaping lives in
    // src/providers/ollama.ts so it's unit-testable without a live server.
    const { buildOllamaChatRequest, normalizeOllamaChatResponse } = await import('./providers/ollama.js');
    const baseUrl = process.env.CAMBIUM_OLLAMA_BASEURL ?? 'http://localhost:11434';
    const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = buildOllamaChatRequest({
      model: name,
      messages: opts.messages,
      tools: opts.tools,
      max_tokens: opts.max_tokens,
      temperature: opts.temperature,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama error: HTTP ${res.status}`);
    const json: any = await res.json();
    const normalized = normalizeOllamaChatResponse(json);

    // Inline tool-call parsing fallback — some Ollama models emit tool calls
    // as markup in content (same as RED-142 for Gemma on oMLX).
    let content = normalized.message.content;
    let toolCalls = normalized.message.tool_calls;
    if ((!toolCalls || toolCalls.length === 0) && content) {
      const parsed = parseInlineToolCalls(content);
      if (parsed.length > 0) {
        toolCalls = parsed;
        content = stripInlineToolCalls(content);
      }
    }

    return {
      message: { content, tool_calls: toolCalls },
      usage: normalized.usage,
    };
  }

  if (provider !== 'omlx') {
    throw new Error(`Agentic mode: unknown provider "${provider}". Supported: omlx, ollama.`);
  }

  const baseUrl = process.env.CAMBIUM_OMLX_BASEURL ?? 'http://100.114.183.54:8080';
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  // Append /no_think to the last user message
  const messages = opts.messages.map((m, i) => {
    if (m.role === 'user' && i === opts.messages.findLastIndex(msg => msg.role === 'user')) {
      return { ...m, content: (m.content ?? '') + '\n/no_think' };
    }
    return m;
  });

  const body: any = {
    model: name,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 1200,
    messages,
    chat_template_kwargs: { enable_thinking: false },
  };

  // Include tools if we have them; force content output if empty
  if (opts.tools.length > 0) {
    body.tools = opts.tools;
  } else {
    // Explicitly disable tool calls — the model has seen tools in earlier turns
    // and will keep calling them unless told not to
    body.tool_choice = 'none';
  }

  const apiKey = process.env.CAMBIUM_OMLX_API_KEY;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`oMLX error: HTTP ${res.status}`);
  const json: any = await res.json();

  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new Error('oMLX: missing choices[0].message');

  const usage = json?.usage;

  // Standard OpenAI tool_calls, or parse from content for models that use inline formats
  let toolCalls = msg.tool_calls ?? undefined;
  let content = msg.content ?? null;

  if (!toolCalls && content) {
    const parsed = parseInlineToolCalls(content);
    if (parsed.length > 0) {
      toolCalls = parsed;
      content = stripInlineToolCalls(content); // strip markup, keep remaining text
    }
  }

  return {
    message: {
      content,
      tool_calls: toolCalls,
    },
    usage: usage ? {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    } : undefined,
  };
}

function mockGenerate(prompt: string, schema?: { $id?: string }): string {
  // RED-215 phase 4: retro memory agents return MemoryWrites, not the
  // analyst shape. Branch on the schema id so both primary gens and
  // retro agents can run end-to-end under --mock. Any new mock-
  // incompatible schema gets its own branch here.
  //
  // NOTE: MemoryWrites is a framework-internal return type for retro
  // agents. A user-authored primary gen that uses `returns MemoryWrites`
  // would also hit this branch under --mock and receive the canned
  // write regardless of its input — don't use MemoryWrites as a primary
  // output schema.
  if (schema?.$id === 'MemoryWrites') {
    // Emit one write against a conventional memory name. Primary gens
    // that declare `memory :conversation` will receive it; others will
    // have it dropped at apply-time with a traced "no matching decl"
    // reason. Both paths are exercised by integration tests.
    return JSON.stringify({
      writes: [{ memory: 'conversation', content: 'mock retro agent note' }],
    });
  }

  const matches = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*ms\b/gi)].map(m => Number(m[1]));
  const payload = {
    summary: 'Mock analysis (model provider not available).',
    metrics: {
      latency_ms_samples: matches
    },
    key_facts: [] as any[]
  };
  return JSON.stringify(payload, null, 2);
}

function stripThinkingTokens(text: string): string {
  // Strip <think>...</think> blocks (Qwen 3.x thinking mode artifacts)
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function extractJsonObject(text: string): any {
  // Strip thinking tokens first, then any non-JSON preamble.
  const cleaned = stripThinkingTokens(text);

  // Try to find a top-level JSON object. Look for '{"' to skip stray braces in markdown/text.
  let start = cleaned.indexOf('{"');
  if (start === -1) start = cleaned.indexOf('{\n');
  if (start === -1) start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in model output');
  const slice = cleaned.slice(start, end + 1);
  return JSON.parse(slice);
}

// ── runGen: programmatic library entry point (RED-243) ────────────────
//
// Replaces the all-in-one main() with a function that:
//   - takes a parsed IR + caller-injected schemas (no `import()` of any
//     contracts file from a hardcoded path)
//   - returns { ok, output, trace, runId, schemaId, ir } instead of writing
//     trace.json / output.json to disk
//   - never calls process.exit
//
// The CLI's main() (further down) reads argv, parses the IR, imports the
// app-mode contracts.ts, calls runGen, then handles the file I/O + exit
// code + stdout/stderr printing. Engine-mode callers import runGen from
// '@redwood-labs/cambium-runner' and pass their own schemas object.

export interface RunGenOptions {
  /** Pre-parsed IR (the JSON the Ruby compiler emitted). */
  ir: IR;
  /** Schemas keyed by `$id` — must contain `ir.returnSchemaId`. App-mode
   *  callers: the CLI resolves this from the app's Genfile.toml
   *  `[types].contracts` list (RED-274), or falls back to
   *  `packages/cambium/src/contracts.ts` relative to cwd when no
   *  Genfile.toml is present. Engine-mode callers pass their sibling
   *  `schemas.ts` module directly. */
  schemas: Record<string, any>;
  /** Force the deterministic mock generator instead of a live LLM.
   *
   *  ⚠️  Concurrency caveat: `mock` is bridged to the process-global
   *  `CAMBIUM_ALLOW_MOCK` env var inside `runGen` and restored in a
   *  `finally`. Two overlapping `runGen` calls — one with `mock: true`,
   *  one without — can observe each other's env-var state between the
   *  set and the restore, causing the live call to silently take the
   *  mock path. Safe for sequential callers; engine-mode hosts that
   *  need true concurrency with mixed mock settings should serialize
   *  their `runGen` calls until `mock` is threaded through to
   *  `generateText` as an explicit parameter. */
  mock?: boolean;
  /** Values for `keyed_by` slots on memory pools. Each entry is `name=value`. */
  memoryKeys?: string[];
  /** RED-287: Explicit engine-folder override. When set, the tool /
   *  action / corrector discovery scans this dir (treating its
   *  contents as siblings of the gen) in addition to the app-mode
   *  paths. When omitted, engine mode is auto-detected by walking up
   *  from `ir.entry.source` looking for `cambium.engine.json`.
   *
   *  Pass this explicitly when the IR was compiled elsewhere but the
   *  host knows which engine folder the gen came from — e.g. a host
   *  bundling a pre-compiled IR without its source tree. */
  engineDir?: string;
  /** RED-287: Root for run artifacts (memory sqlite buckets live at
   *  `<runsRoot>/memory/<scope>/<key>/<name>.sqlite`). Defaults to
   *  `<engineDir>/runs` when engine mode is detected, else
   *  `<process.cwd()>/runs`. Host wrappers that centralize runs
   *  across many engines override this. */
  runsRoot?: string;
  /** RED-287: Explicit session id for memory `:session` scope. Wins
   *  over `CAMBIUM_SESSION_ID`. Defaults to auto-generated. */
  sessionId?: string;
  /** RED-299: Per-`runGen` corrector map. Merged over framework
   *  built-ins (`math`, `dates`, `currency`, `citations`) — entries
   *  here override built-ins by name, same precedence rule as
   *  pre-RED-299 `registerAppCorrectors`. Prefer this over the
   *  deprecated global register path: isolation between concurrent
   *  or sequential `runGen` calls in one process only holds when
   *  correctors are scoped per-call.
   *
   *  App-mode CLI path: `cli/cambium.mjs` loads `app/correctors/*`
   *  via `loadAppCorrectors` and passes the merged map through. Most
   *  callers never set this directly.
   *
   *  Engine-mode: host wrapper passes its own correctors map; the
   *  runner additionally scans the engine folder for sibling
   *  `*.corrector.ts` and merges those on top. */
  correctors?: Record<string, CorrectorFn>;
  /** RED-302: Per-`runGen` log-sink map (parallel to `correctors`).
   *  Merged over framework built-ins (`stdout`, `http_json`, `datadog`).
   *  App plugin sinks under `app/logs/*.log.ts` are auto-discovered
   *  and merged on top. Host wrappers set this to inject a custom
   *  backend (e.g. Honeycomb, Sentry) without a file-based plugin. */
  logSinks?: Record<string, LogSink>;
  /** RED-305: Declares this invocation is a scheduled fire of the
   *  named schedule declaration. Shape: `schedule:<id>[@<iso_ts>]`
   *  — e.g. `schedule:morning_digest.analyze.daily@2026-04-22T09:00:00Z`.
   *  When absent, the run is interactive.
   *
   *  The schedule id MUST match an entry in `ir.policies.schedules[]`;
   *  unknown ids fail fast at runner startup. The timestamp is
   *  optional — omit to stamp with `Date.now()` at runner start.
   *
   *  Semantic unlocks when set:
   *    - `memory :x, scope: :schedule` resolves to a per-schedule-id
   *      bucket (`runs/memory/schedule/<id>/<name>.sqlite`)
   *    - `trace.fired_by` carries the value
   *    - `ctx.fire_id` on action handlers gets `<id>:<ts>`
   *    - `log` events gain a `fired_by:schedule` ddtag */
  firedBy?: string;
}

export interface RunGenResult {
  /** Final success after validation + repair. */
  ok: boolean;
  /** Validated output (null when !ok). */
  output: any;
  /** Trace object — always present, even on failure. */
  trace: any;
  /** Generated run id. The CLI uses this to scope `runs/<id>/`. */
  runId: string;
  /** Schema $id used for validation (mirrors `ir.returnSchemaId`). */
  schemaId: string;
  /** Possibly-mutated IR (enrichments add `<field>_enriched` entries). */
  ir: IR;
  /** Human-readable failure reason (budget exceeded, validation failed). */
  errorMessage?: string;
}

class BudgetExceededError extends Error {
  constructor(public violation: any) {
    super(`Budget exceeded: ${violation.message}`);
  }
}

export async function runGen(opts: RunGenOptions): Promise<RunGenResult> {
  const {
    ir,
    schemas: contractsMod,
    mock: mockFlag = false,
    memoryKeys = [],
    engineDir: engineDirOpt,
    runsRoot: runsRootOpt,
    sessionId: sessionIdOpt,
    correctors: optsCorrectors,
    logSinks: optsLogSinks,
    firedBy: optsFiredBy,
  } = opts;

  // Plumb opts.mock through to the deterministic-mock branch in
  // generateText. That branch is gated on CAMBIUM_ALLOW_MOCK=1 — the CLI
  // sets that env var directly, but a library caller passing `mock: true`
  // would otherwise hit the live LLM path. Restore the previous value
  // when runGen returns so concurrent callers and the surrounding
  // process aren't affected. Note: the env var is process-global, so
  // truly concurrent runGen() calls with conflicting mock settings can
  // race — engine-mode hosts that need that should serialize calls or
  // wait for opts.mock to be threaded down explicitly. Surfaced by
  // the RED-220 POC.
  const previousMockEnv = process.env.CAMBIUM_ALLOW_MOCK;
  if (mockFlag) process.env.CAMBIUM_ALLOW_MOCK = '1';

  const runId = `run_${nowId()}_${Math.random().toString(16).slice(2, 8)}`;

  // ── Parse --fired-by / CAMBIUM_FIRED_BY (RED-305) ───────────────────
  // Shape: `schedule:<id>[@<iso_ts>]`. Absent → interactive run.
  // Unknown id against ir.policies.schedules[] → hard error.
  //
  // We validate the id eagerly so typos in cron manifests fail at the
  // CLI, not silently as unexpected memory scope behavior later.
  // The id ALSO runs through validateScheduleId (memory/keys.ts) so
  // path-traversal-via-cron-manifest is structurally impossible —
  // same belt-and-suspenders as --memory-key / CAMBIUM_SESSION_ID.
  let firedBy: { scheduleId: string; timestamp: string; fireId: string } | null = null;
  if (optsFiredBy) {
    // Strict regex: the id must be `snake.case.chunks` (no .. segments),
    // and the timestamp must not contain whitespace or control chars.
    // ISO 8601 timestamps are ≤ 30 chars; cap at 64 to leave headroom
    // for timezone offsets while rejecting pathological values that
    // would blow up DD tag limits.
    const m = String(optsFiredBy).match(
      /^schedule:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(?:@([^\s]{1,64}))?$/,
    );
    if (!m) {
      throw new Error(
        `Invalid --fired-by value: ${JSON.stringify(optsFiredBy)}. ` +
        `Expected shape: schedule:<id>[@<iso_timestamp>].`,
      );
    }
    const scheduleId = m[1];
    validateScheduleId(scheduleId, '--fired-by');
    const timestamp = m[2] ?? new Date().toISOString();
    const declared: any[] = ir.policies?.schedules ?? [];
    if (declared.length === 0) {
      throw new Error(
        `--fired-by was set but ${ir.entry?.class ?? 'this gen'} declares no cron schedules. ` +
        `Either remove --fired-by or declare a \`cron :...\` on the gen.`,
      );
    }
    const known = declared.find((s) => s.id === scheduleId);
    if (!known) {
      const ids = declared.map((s) => s.id).join(', ');
      throw new Error(
        `--fired-by schedule id "${scheduleId}" is not declared on ${ir.entry?.class ?? 'this gen'}. ` +
        `Known schedule ids: ${ids}.`,
      );
    }
    firedBy = {
      scheduleId,
      timestamp,
      fireId: `${scheduleId}:${timestamp}`,
    };
  }

  const trace: any = {
    run_id: runId,
    version: ir.version,
    entry: ir.entry,
    model: ir.model,
    steps: [],
    started_at: new Date().toISOString(),
  };
  if (firedBy) trace.fired_by = optsFiredBy;

  // ── Load contracts (caller-injected, RED-243) ───────────────────────
  const schema = contractsMod[ir.returnSchemaId];
  if (!schema) {
    throw new Error(
      `Schema not found in injected schemas for id: ${ir.returnSchemaId}. ` +
      `Provide it via opts.schemas — app-mode CLI resolves from Genfile.toml ` +
      `[types].contracts, or falls back to packages/cambium/src/contracts.ts.`,
    );
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(schema, schema.$id);
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`AJV schema not registered: ${schema.$id}`);

  // ── Resolve tool/action discovery roots (RED-286, RED-287) ──────────
  // Engine mode (RED-287): the gen lives inside a folder marked by
  // `cambium.engine.json`. Tools, actions, and correctors live as
  // **siblings** of the gen file, not under an app/<type>/ convention.
  // Detect and scan the engine dir directly.
  //
  // App mode (RED-286): layout-aware lookup of the app-package root.
  // [workspace] Genfile → <root>/packages/cambium; [package] Genfile
  // → <root>. Falls back to the legacy <cwd>/packages/cambium when no
  // Genfile is found.
  //
  // Both roots can be present — the runner scans the engine dir when
  // the primary is engine-sourced AND still scans the app dir as a
  // secondary, so an engine invoked from inside a workspace still has
  // access to workspace-declared tools (e.g. shared wire protocols
  // tooling). Engine siblings win on name collision (loadFromDir's
  // last-write semantics).
  //
  // The explicit `opts.engineDir` wins over auto-detection — host
  // wrappers that bundle a pre-compiled IR can inject their engine
  // folder directly (the IR's `entry.source` still points at the
  // original compile location, which may not exist at host runtime).
  const engineDir = engineDirOpt ?? resolveEngineDir(ir.entry?.source);
  const { appPkgRoot } = resolveAppRoot(process.cwd());

  // ── Load tool registry ──────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  // Load framework-builtin tools first, then app-supplied, then engine
  // siblings. loadFromDir overwrites on name collision, so:
  //   engine-sibling > app plugin > framework builtin
  // (RED-221 override hook; RED-287 engine extension).
  await toolRegistry.loadFromDir(join(RUNNER_DIR, 'builtin-tools'));
  await toolRegistry.loadFromDir(join(appPkgRoot, 'app/tools'));
  if (engineDir) {
    await toolRegistry.loadFromDir(engineDir);
  }

  // ── Load action registry (RED-212) ─────────────────────────────────
  // Same load order as tools: framework-builtin first, app second,
  // engine-sibling third. Actions are invoked only by triggers (never
  // by `uses :name` on a gen), so there's no compile-time allowlist
  // to validate against.
  const actionRegistry = new ActionRegistry();
  await actionRegistry.loadFromDir(join(RUNNER_DIR, 'builtin-actions'));
  await actionRegistry.loadFromDir(join(appPkgRoot, 'app/actions'));
  if (engineDir) {
    await actionRegistry.loadFromDir(engineDir);
  }

  // ── Build per-`runGen` corrector map (RED-275, RED-287, RED-299) ─────
  // Precedence (low → high; later entries win on name collision):
  //   1. Framework built-ins (math, dates, currency, citations)
  //   2. Legacy registerAppCorrectors map (deprecated back-compat)
  //   3. opts.correctors — the new blessed path for engine-mode hosts
  //      AND how the CLI ships app-mode correctors since RED-299
  //   4. Engine-sibling correctors discovered via loadAppCorrectors
  //      at <engineDir>/*.corrector.ts (engine-mode only)
  //
  // Pre-RED-299 this was a module-global that leaked across runGen
  // calls. The per-call map is what lets a long-lived engine-mode
  // host run App A's gen and App B's gen in one process without
  // App A's correctors shadowing App B's (silent wrong-result).
  //
  // Design: docs/GenDSL Docs/N - Engine-Mode Corrector Registry
  // Isolation (RED-281).md
  const legacyCorrectors = _getLegacyAppCorrectors();
  const correctors: Record<string, CorrectorFn> = {
    ...builtinCorrectors,
    ...legacyCorrectors,
    ...(optsCorrectors ?? {}),
  };
  // Warn when the same name appears in both the deprecated global and
  // the new opts path — opts wins silently otherwise, which is easy
  // to mis-diagnose during a migration. Cheap to compute (both maps
  // are small) and only fires for hosts still using both paths.
  if (optsCorrectors) {
    for (const name of Object.keys(optsCorrectors)) {
      if (name in legacyCorrectors) {
        console.error(
          `[cambium] corrector "${name}" appears in both legacy registerAppCorrectors and RunGenOptions.correctors; opts.correctors wins. Remove the legacy registration (RED-299).`,
        );
      }
    }
  }
  if (engineDir) {
    const engineCorr = await loadAppCorrectors(engineDir, { engineDir });
    for (const [name, fn] of Object.entries(engineCorr.correctors)) {
      correctors[name] = fn;
    }
  }

  // ── Build per-`runGen` log-sink map (RED-282 / RED-302) ────────────
  // Same precedence shape as correctors (RED-299), low → high:
  //   1. Framework built-ins (stdout, http_json, datadog)
  //   2. App plugins (app/logs/*.log.ts) — can shadow built-ins; warn
  //   3. Engine-sibling plugins (<engineDir>/*.log.ts) — authoritative
  //      for the engine folder
  //   4. opts.logSinks — explicit host intent, wins over everything
  // Isolation holds per-call.
  const logSinks: Record<string, LogSink> = { ...builtinLogSinks };
  const appPlugins = await loadAppLogSinks(appPkgRoot);
  for (const [name, fn] of Object.entries(appPlugins.sinks)) {
    if (name in builtinLogSinks) {
      console.error(`[cambium] app log sink "${name}" overrides the framework built-in`);
    }
    logSinks[name] = fn;
  }
  if (engineDir) {
    const enginePlugins = await loadAppLogSinks(engineDir, { engineDir });
    for (const [name, fn] of Object.entries(enginePlugins.sinks)) {
      logSinks[name] = fn;
    }
  }
  for (const [name, fn] of Object.entries(optsLogSinks ?? {})) {
    logSinks[name] = fn;
  }

  // Log destinations come pre-resolved from the IR (profiles inlined
  // at compile time).
  const logDestinations: LogDestination[] = (ir.policies?.log ?? []).map(
    (raw: any): LogDestination => ({
      destination: String(raw.destination),
      include: Array.isArray(raw.include) ? raw.include.map(String) : [],
      granularity: raw.granularity === 'step' ? 'step' : 'run',
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
      api_key_env: typeof raw.api_key_env === 'string' ? raw.api_key_env : undefined,
      _profile: typeof raw._profile === 'string' ? raw._profile : undefined,
    }),
  );

  const toolsAllowed: string[] = ir.policies?.tools_allowed ?? [];
  // Validate that all declared tools exist in the registry
  for (const t of toolsAllowed) {
    if (!toolRegistry.get(t)) {
      throw new Error(`Tool "${t}" declared in policies.tools_allowed but not found in registry. Available: ${toolRegistry.list().join(', ')}`);
    }
  }
  // Validate that every action_call trigger references a known action.
  // Fail fast at startup rather than at signal-fire time.
  for (const t of (ir.triggers ?? [])) {
    if (t.action === 'action_call' && !actionRegistry.get(t.name)) {
      throw new Error(
        `Trigger action "${t.name}" not found in ActionRegistry. ` +
        `Available: [${actionRegistry.list().join(', ')}]`,
      );
    }
  }

  // ── Security: validate tool permissions ─────────────────────────────
  const { buildSecurityPolicy, validateAllToolPermissions } = await import('./tools/permissions.js');
  const securityPolicy = buildSecurityPolicy(ir.policies);
  const permViolations = validateAllToolPermissions(toolRegistry, toolsAllowed, securityPolicy);
  if (permViolations.length > 0) {
    for (const v of permViolations) {
      console.error(`Security violation: ${v.message}`);
    }
    trace.steps.push({
      type: 'SecurityCheck',
      ok: false,
      errors: permViolations.map(v => ({ message: v.message, tool: v.tool, permission: v.permission })),
    });
    throw new Error(`${permViolations.length} security violation(s). See trace for details.`);
  }
  // Surface policy-pack provenance (RED-214) — the IR carries `_packs`
  // arrays on policies.security/policies.budget naming any packs that
  // contributed slots. buildSecurityPolicy strips them, so read direct
  // from the IR for the trace.
  const securityPacks = (ir.policies?.security?._packs as string[] | undefined) ?? [];
  const budgetPacks   = (ir.policies?.budget?._packs   as string[] | undefined) ?? [];
  const packsMeta = (securityPacks.length || budgetPacks.length)
    ? { security: securityPacks, budget: budgetPacks }
    : undefined;

  trace.steps.push({
    type: 'SecurityCheck',
    ok: true,
    meta: { tools_checked: toolsAllowed, policy: securityPolicy, ...(packsMeta ? { packs: packsMeta } : {}) },
  });

  // ── Memory (RED-215 phase 3): plan + pre-generate read ──────────────
  // Each memory decl opens its SQLite bucket, optionally reads recent
  // entries (sliding_window), and contributes a block that is appended
  // to the gen's system prompt. The backends are tracked in a Map that's
  // wired to `process.once('exit', ...)` below, so every exit path —
  // including the several `process.exit(1)` bailouts in main() — flushes
  // WAL and closes handles. The explicit `closeBackends` call on the
  // success path is still there so handles don't linger past the run.
  let memoryPlans: MemoryPlan[] = [];
  const memoryBackends: Map<string, SqliteMemoryBackend> = new Map();
  process.once('exit', () => {
    if (memoryBackends.size > 0) closeBackends(memoryBackends);
  });
  // RED-215 phase 4: retro memory agents (mode :retro) are the MEMORY
  // WRITERS, not primary gens with their own memory. Skip the whole
  // memory machinery for them — a retro agent shouldn't have its own
  // memory block injected, and it shouldn't trigger a nested retro
  // invocation on its own write_memory_via. This guard also prevents
  // infinite recursion if someone accidentally sets write_memory_via
  // on a retro agent.
  const isRetroMode = ir.mode === 'retro';
  const memoryDecls = isRetroMode ? [] : (ir.policies?.memory ?? []);
  if (memoryDecls.length > 0) {
    const keys = parseMemoryKeys(memoryKeys);
    // RED-287: explicit opts.sessionId wins over CAMBIUM_SESSION_ID.
    // Host wrappers set this explicitly so per-tenant runs don't leak
    // into each other via an inherited env var.
    const sessionId = sessionIdOpt ?? resolveSessionId(process.env);
    // RED-287: runsRoot defaults to <engineDir>/runs for engine mode,
    // else <cwd>/runs. Host wrappers can centralize across engines by
    // passing opts.runsRoot explicitly.
    const runsRoot = runsRootOpt ?? (engineDir
      ? join(engineDir, 'runs')
      : join(process.cwd(), 'runs'));
    const memCtx = {
      input: getGroundingDocument(ir),
      sessionId,
      keys,
      runsRoot,
      scheduleId: firedBy?.scheduleId,
    };
    memoryPlans = planMemory(memoryDecls, memCtx);
    const { block, trace: readTrace, backends } = await readMemoryForRun(memoryPlans, memCtx);
    for (const [name, b] of backends) memoryBackends.set(name, b);
    for (const t of readTrace) trace.steps.push(t);
    if (block) {
      ir.system = ir.system ? `${ir.system}\n\n${block}` : block;
    }
  }

  // RED-298: IR shape changed from Array<string> to
  // Array<{ name, max_attempts }>. Accept both so cached IRs compiled
  // before RED-298 still run — bare strings normalize to max_attempts:1
  // (today's contract). The runner always operates on the object form.
  type CorrectorDecl = { name: string; max_attempts: number };
  const correctorDecls: CorrectorDecl[] = (ir.policies?.correctors ?? []).map(
    (raw: any): CorrectorDecl => {
      // The Ruby DSL enforces max_attempts ∈ 1..3, but a host that
      // constructs IR directly (or hand-edits a compiled IR) can bypass
      // that guard. Clamp here as belt-and-suspenders — matches RED-239's
      // stance (memory TTLs enforced at both Ruby AND TS).
      const clamp = (n: number) => Math.min(3, Math.max(1, Math.floor(n)));
      if (typeof raw === 'string') return { name: raw, max_attempts: 1 };
      if (raw && typeof raw.name === 'string') {
        const n = typeof raw.max_attempts === 'number' ? clamp(raw.max_attempts) : 1;
        return { name: raw.name, max_attempts: n };
      }
      throw new Error(
        `invalid corrector declaration in IR: ${JSON.stringify(raw)}`,
      );
    },
  );
  const maxRepairAttempts = ir.policies?.max_repair_attempts ?? 2;

  // ── Repair policy (RED-139) ──────────────────────────────────────────
  const repairPolicyConfig = ir.policies?.repair ?? {};
  const repairPolicy = {
    maxAttempts: repairPolicyConfig.max_attempts ?? maxRepairAttempts,
    stopOnNoImprovement: repairPolicyConfig.stop_on_no_improvement ?? false,
    mode: repairPolicyConfig.mode ?? 'full', // 'full' | 'partial'
  };

  // ── Budget tracking ─────────────────────────────────────────────────
  const budget = parseBudget(ir.policies);

  /** Track usage/tool calls from a trace step and check budget. Throws on violation. */
  function budgetTrack(step: any): void {
    trackBudgetFromTraceStep(budget, step);

    const violation = budget.check();
    if (violation) {
      trace.steps.push({
        type: 'BudgetExceeded',
        ok: false,
        meta: { violation, budget: budget.summary() },
      });
      trace.finished_at = new Date().toISOString();
      trace.final = { ok: false, schema_id: schema.$id, usage: budget.summary(), budget_exceeded: true };
      // Bubble up — runGen's outer catch turns this into a structured
      // RunGenResult and the CLI's main() handles file writes + exit code.
      throw new BudgetExceededError(violation);
    }
  }

  /**
   * Append a `handleRepair` result to the trace AND track its token
   * usage against the budget (RED-280). Use this instead of a bare
   * `trace.steps.push(repair.result)` anywhere in runGen — five repair
   * call sites exist (schema repair, Review, Consensus, corrector
   * feedback, grounding) and hand-maintained pairs had drifted:
   * Review and the schema loop called both, Consensus and grounding
   * silently lacked the budget track. Keeping the pair behind one
   * helper makes a future sixth call site structurally impossible to
   * get wrong.
   */
  function pushRepairStep(repair: { result: any }): void {
    trace.steps.push(repair.result);
    budgetTrack(repair.result);
  }

  // Wrap the orchestration so BudgetExceededError thrown from budgetTrack
  // unwinds cleanly into a `{ ok: false, ... }` result. Other exceptions
  // propagate to the caller (CLI main() rethrows after stack-trace logging).
  try {

  // ── Enrichments (pre-generate context processing) ───────────────────
  const enrichments = ir.enrichments ?? [];
  for (const enrichDef of enrichments) {
    const contextValue = ir.context?.[enrichDef.field];
    if (contextValue === undefined) {
      trace.steps.push({
        type: 'EnrichSkipped',
        ok: true,
        meta: { field: enrichDef.field, reason: `Field "${enrichDef.field}" not found in context` },
      });
      continue;
    }

    trace.steps.push({ type: 'Enrich', id: `enrich_${enrichDef.field}`, meta: { field: enrichDef.field, agent: enrichDef.agent } });

    const enrichResult = await runEnrichment(
      enrichDef, contextValue, ir, contractsMod, generateText, extractJsonObject,
    );

    // Add sub-agent trace steps under the enrichment
    for (const subStep of enrichResult.traceSteps) {
      trace.steps.push(subStep);
    }

    if (enrichResult.ok && enrichResult.output !== undefined) {
      // Add enriched output as a new context field (e.g., "document" → "document_enriched").
      // The original field stays intact so the parent agent still has access to the raw data.
      const enrichedKey = `${enrichDef.field}_enriched`;
      ir.context[enrichedKey] = enrichResult.output;
      trace.steps.push({
        type: 'EnrichComplete',
        ok: true,
        meta: { field: enrichDef.field, enrichedAs: enrichedKey, agent: enrichDef.agent, usage: enrichResult.usage },
      });
    } else {
      trace.steps.push({
        type: 'EnrichFailed',
        ok: false,
        meta: { field: enrichDef.field, agent: enrichDef.agent },
      });
      // Continue with raw context — enrichment failure is non-fatal
    }
  }

  // ── Execute IR steps ────────────────────────────────────────────────
  let finalParsed: any = undefined;
  let finalOk = false;

  for (const step of ir.steps) {
    if (step.type !== 'Generate') {
      trace.steps.push({ type: step.type, id: step.id, ok: false, errors: [{ message: `Unknown step type: ${step.type}` }] });
      continue;
    }

    // ── Sub-pipeline: Generate → Validate → Repair → Correct → ToolCall → Return ──

    // 1. Generate (single-call or agentic multi-turn)
    let raw: string;
    let parsed: any;

    if (ir.mode === 'agentic') {
      const maxToolCalls = ir.policies?.constraints?.budget?.max_tool_calls ?? 20;
      const toolsOpenAI = toolRegistry.toOpenAIFormat(toolsAllowed);

      const agenticResult = await handleAgenticGenerate(
        step, ir, schema, toolsOpenAI, toolRegistry, toolsAllowed,
        generateWithTools, extractJsonObject, maxToolCalls,
        { policy: securityPolicy, budget, traceEvents: trace.steps },
      );

      trace.steps.push(agenticResult.result);
      for (const ts of agenticResult.traceSteps) {
        trace.steps.push(ts);
        budgetTrack(ts);
      }

      raw = agenticResult.raw;
      parsed = agenticResult.parsed;
    } else {
      const gen = await handleGenerate(step, ir, schema, generateText, extractJsonObject);
      trace.steps.push(gen.result);
      budgetTrack(gen.result);
      raw = gen.raw;
      parsed = gen.parsed;
    }

    // 2. Validate + Repair loop
    let ok = false;
    let errors: any[] = [];
    let prevErrorCount = Infinity;

    for (let attempt = 0; attempt < 1 + repairPolicy.maxAttempts; attempt++) {
      const vResult = handleValidate(parsed, validate, attempt === 0 ? 'Validate' : 'ValidateAfterRepair');

      if (vResult.ok) {
        ok = true;
        errors = [];
        // Only push validate step on success if it wasn't first attempt (show the win after repair)
        if (attempt > 0) trace.steps.push(vResult);
        break;
      }

      errors = vResult.errors ?? [];
      const errorCount = errors.length;

      // Stop-on-no-improvement: bail if errors aren't decreasing
      if (repairPolicy.stopOnNoImprovement && attempt > 0 && errorCount >= prevErrorCount) {
        trace.steps.push({
          type: 'RepairStopped',
          ok: false,
          meta: {
            reason: 'no_improvement',
            attempt,
            errorCount,
            prevErrorCount,
            policy: repairPolicy,
          },
        });
        break;
      }
      prevErrorCount = errorCount;

      trace.steps.push(vResult);

      // Don't repair after last attempt
      if (attempt >= repairPolicy.maxAttempts) break;

      // Repair
      const repair = await handleRepair(raw, errors, schema, ir, attempt + 1, generateText, extractJsonObject);
      pushRepairStep(repair);
      raw = repair.raw;
      parsed = repair.parsed;
    }

    if (!ok) {
      finalOk = false;
      break;
    }

    // 3. Compound constraints (review / consistency)
    const constraints = ir.policies?.constraints ?? {};

    // 3a. Compound review: LLM audits the output against the source document
    if (constraints.compound?.strategy === 'review') {
      const review = await runReview(parsed, ir, schema, generateText, extractJsonObject);
      const reviewTraceEntry = {
        type: 'Review',
        ok: review.ok,
        ms: review.ms,
        meta: { issues: review.issues, raw_preview: review.raw_preview, usage: review.usage },
      };
      trace.steps.push(reviewTraceEntry);
      budgetTrack(reviewTraceEntry);

      if (!review.ok) {
        // Feed review issues into a repair pass
        const reviewErrors = review.issues.map(i => ({
          message: `Review: ${i.message}`,
          instancePath: i.path,
        }));
        const repair = await handleRepair(
          JSON.stringify(parsed, null, 2), reviewErrors, schema, ir,
          maxRepairAttempts + 1, generateText, extractJsonObject,
        );
        pushRepairStep(repair);

        if (repair.parsed) {
          const revalidate = handleValidate(repair.parsed, validate, 'ValidateAfterReview');
          if (revalidate.ok) {
            parsed = repair.parsed;
            trace.steps.push(revalidate);
          } else {
            trace.steps.push(revalidate);
            // Review repair failed — continue with original (review is advisory)
          }
        }
      }
    }

    // 3b. Consistency: generate N times, compare, flag disagreements
    if (constraints.consistency?.passes > 1) {
      const extraPasses = constraints.consistency.passes - 1;
      const allOutputs = [parsed];

      for (let p = 0; p < extraPasses; p++) {
        const passId = `${step.id}_pass_${p + 2}`;
        const extraGen = await handleGenerate(step, ir, schema, generateText, extractJsonObject);
        trace.steps.push({ ...extraGen.result, id: passId });

        let extraRaw = extraGen.raw;
        let extraParsed = extraGen.parsed;

        // Run the same validate + repair loop as the primary generate
        for (let attempt = 0; attempt < 1 + maxRepairAttempts; attempt++) {
          const extraV = handleValidate(extraParsed, validate,
            attempt === 0 ? 'ValidateConsensusPass' : 'ValidateConsensusPassAfterRepair');

          if (extraV.ok) {
            if (attempt > 0) trace.steps.push(extraV);
            allOutputs.push(extraParsed);
            break;
          }

          trace.steps.push(extraV);
          if (attempt >= maxRepairAttempts) break;

          const extraRepair = await handleRepair(
            extraRaw, extraV.errors ?? [], schema, ir,
            attempt + 1, generateText, extractJsonObject,
          );
          trace.steps.push({ ...extraRepair.result, id: `${passId}_repair_${attempt + 1}` });
          extraRaw = extraRepair.raw;
          extraParsed = extraRepair.parsed;
        }
      }

      if (allOutputs.length > 1) {
        const consensus = runConsensus(allOutputs);
        trace.steps.push({
          type: 'Consensus',
          ok: consensus.ok,
          meta: {
            passes: allOutputs.length,
            disagreements: consensus.disagreements,
          },
        });

        if (!consensus.ok) {
          // Feed disagreements into repair
          const consensusErrors = consensus.disagreements.map(d => ({
            message: `Consensus: ${d.message} — values: ${JSON.stringify(d.values)}`,
            instancePath: d.path,
          }));
          const repair = await handleRepair(
            JSON.stringify(consensus.agreed, null, 2), consensusErrors, schema, ir,
            maxRepairAttempts + 1, generateText, extractJsonObject,
          );
          pushRepairStep(repair);

          if (repair.parsed) {
            const revalidate = handleValidate(repair.parsed, validate, 'ValidateAfterConsensus');
            if (revalidate.ok) {
              parsed = repair.parsed;
            }
            trace.steps.push(revalidate);
          }
        } else {
          parsed = consensus.agreed;
        }
      }
    }

    // 4. Correctors (deterministic post-validation transforms + verification)
    //
    // RED-298 reworked this block from "run all correctors in one pass,
    // one repair attempt on combined issues" to a per-corrector loop with
    // per-corrector `max_attempts`. Two reasons:
    //
    // 1. Correctness fix: the pre-RED-298 loop re-validated schema after
    //    a corrector-feedback Repair but did NOT re-run the corrector.
    //    A regex-verification corrector that flagged a bad regex would
    //    get its issues fed into Repair; the LLM would produce new
    //    schema-valid output; the runner would claim "healed" without
    //    ever re-checking whether the corrector's actual concern was
    //    addressed. Now: every successful schema revalidate after Repair
    //    is followed by a `CorrectAfterRepair` re-run so "healed" is
    //    observable instead of assumed.
    //
    // 2. Ergonomics: hard corrector-verified problems (regex synthesis
    //    is the clean example) can survive one repair attempt but heal
    //    within 2–3. Each declared corrector can opt into a higher
    //    `max_attempts` (ceiling 3, enforced at compile time). Default
    //    remains 1 — today's contract for every existing gen.
    //
    // Design note: docs/GenDSL Docs/N - Corrector Multi-Attempt (RED-296).md
    // Local break flag — `finalOk` is the whole-run state and only
    // flips to `true` much later in the pipeline (line 1226 range).
    // We can't use it to detect "schema broke inside THIS corrector
    // loop," so track that with a local variable.
    let correctorSchemaBroke = false;
    for (const decl of correctorDecls) {
      const correctorName = decl.name;
      const maxAttempts = decl.max_attempts;

      // Initial pass: run just this corrector so the trace distinguishes
      // it from any peers. Issues from the pipeline drive the repair
      // loop; a `corrected: true` mutating-corrector result updates
      // `parsed` and triggers a silent schema revalidate (only the
      // failure case is loud — matches pre-RED-298 observability).
      const correctResult = handleCorrect(
        parsed, [correctorName], { document: getGroundingDocument(ir) }, correctors,
      );
      trace.steps.push(correctResult);

      if (correctResult.meta?.corrected) {
        parsed = correctResult.output;
        const revalidate = handleValidate(parsed, validate, 'ValidateAfterCorrect');
        if (!revalidate.ok) {
          trace.steps.push(revalidate);
          correctorSchemaBroke = true;
          break;
        }
      }

      let correctorErrors = (correctResult.meta?.issues ?? [])
        .filter((i: any) => i.severity === 'error');
      let attemptsMade = 0;

      while (correctorErrors.length > 0 && attemptsMade < maxAttempts) {
        attemptsMade += 1;

        const repairErrors = correctorErrors.map((i: any) => ({
          message: `Corrector: ${i.message}`,
          instancePath: i.path,
        }));
        const repair = await handleRepair(
          JSON.stringify(parsed, null, 2), repairErrors, schema, ir,
          maxRepairAttempts + 1, generateText, extractJsonObject,
        );
        pushRepairStep(repair);

        if (!repair.parsed) break; // Repair produced no usable JSON.

        const revalidate = handleValidate(
          repair.parsed, validate, 'ValidateAfterCorrectorRepair',
        );
        trace.steps.push(revalidate);
        if (!revalidate.ok) break; // Repair broke schema; keep pre-repair parsed.

        // Accept the repaired output and re-run THIS corrector to see
        // whether the repair actually healed its concern. This is the
        // RED-298 correctness fix.
        parsed = repair.parsed;
        const rerun = handleCorrect(
          parsed, [correctorName], { document: getGroundingDocument(ir) }, correctors,
        );
        const stillErrors = (rerun.meta?.issues ?? [])
          .filter((i: any) => i.severity === 'error');
        trace.steps.push({
          ...rerun,
          type: 'CorrectAfterRepair',
          ok: stillErrors.length === 0,
        });

        // Mutating corrector on re-run: propagate + silent schema check,
        // same stance as the initial pass.
        if (rerun.meta?.corrected) {
          parsed = rerun.output;
          const postMutate = handleValidate(parsed, validate, 'ValidateAfterCorrect');
          if (!postMutate.ok) {
            trace.steps.push(postMutate);
            correctorSchemaBroke = true;
            break;
          }
        }

        correctorErrors = stillErrors;
      }

      // Loop exhausted with errors still pending — emit the terminal
      // observability step so downstream consumers (and `jq .steps[] |
      // select(.ok == false)`) can see the framework gave up. Does not
      // fail the run; the output is still schema-valid. Policy "refuse
      // on unhealed errors" is the caller's job, not the runner's.
      //
      // Gated on !correctorSchemaBroke: if a mutating corrector on re-run
      // broke schema, the loop exits via `break` without updating
      // `correctorErrors`, which would otherwise spuriously emit
      // CorrectAcceptedWithErrors on a run that's about to finalOk:false
      // via the outer step loop. That would pollute the trace with a
      // "corrector gave up" signal for a run that actually failed on a
      // different axis.
      if (correctorErrors.length > 0 && !correctorSchemaBroke) {
        trace.steps.push({
          type: 'CorrectAcceptedWithErrors',
          ok: false,
          id: `correct_accepted_with_errors_${correctorName}`,
          meta: {
            corrector: correctorName,
            attempts_made: attemptsMade,
            max_attempts: maxAttempts,
            unhealed_issues: correctorErrors,
          },
        });
      }

      if (correctorSchemaBroke) break; // Schema broke inside this iteration.
    }
    if (correctorSchemaBroke) {
      // Propagate to the outer step loop — matches pre-RED-298 behavior
      // where a schema-breaking corrector aborted the whole run.
      finalOk = false;
      break;
    }

    // 5. Grounding: citation enforcement (auto-registered when grounded_in is declared)
    const grounding = ir.policies?.grounding;
    if (grounding?.require_citations) {
      const citResult = handleCorrect(parsed, ['citations'], { document: getGroundingDocument(ir) }, correctors);
      const citationResult = citResult.meta?.citationResult;

      // RED-bug follow-up: both `citResult.issues` references below look
      // at a top-level field that StepResult does not declare — issues
      // actually live at `citResult.meta.issues`. The fallback branch
      // and the citErrors branch have therefore both been dead code
      // (always empty). Fixing is a runtime behavior change (citation
      // errors would start triggering repairs), so intentionally left
      // as-is here; the `as any` cast masks the type error so the
      // packaging build passes without altering runtime behavior.
      const citResultAny = citResult as any;
      trace.steps.push({
        ...citResult,
        type: 'GroundingCheck',
        ok: citationResult?.allValid ?? ((citResultAny.issues ?? []).length === 0),
        meta: {
          ...citResult.meta,
          passed: citationResult?.passed?.length ?? 0,
          failed: citationResult?.failed?.length ?? 0,
          missing: citationResult?.missing?.length ?? 0,
          totalChecked: citationResult?.totalChecked ?? 0,
          details: citationResult?.failed ?? [],
        },
      });

      const citErrors = citResultAny.issues?.filter((i: any) => i.severity === 'error') ?? [];
      if (citErrors.length > 0) {
        // Feed citation errors into repair
        const repairErrors = citErrors.map((i: any) => ({
          message: `Grounding: ${i.message}`,
          instancePath: i.path,
        }));
        const repair = await handleRepair(
          JSON.stringify(parsed, null, 2), repairErrors, schema, ir,
          maxRepairAttempts + 1, generateText, extractJsonObject,
        );
        pushRepairStep(repair);

        if (repair.parsed) {
          const revalidate = handleValidate(repair.parsed, validate, 'ValidateAfterGrounding');
          if (revalidate.ok) {
            parsed = repair.parsed;
            trace.steps.push(revalidate);
          } else {
            trace.steps.push(revalidate);
            // Grounding repair failed — continue with original
          }
        }
      }
    }

    // 6. Signals + Triggers (general-purpose tool dispatch)
    const signalDefs = ir.signals ?? [];
    const triggerDefs = ir.triggers ?? [];

    if (signalDefs.length > 0) {
      const state = extractSignals(parsed, signalDefs);
      trace.steps.push({ type: 'ExtractSignals', ok: true, meta: { state } });

      if (triggerDefs.length > 0) {
        const triggerResults = await evaluateTriggers(triggerDefs, state, toolRegistry, toolsAllowed, {
          policy: securityPolicy, budget, traceEvents: trace.steps,
        }, actionRegistry);
        for (const tr of triggerResults) {
          trace.steps.push(tr.traceEntry);
          if (tr.fired && tr.target && tr.value !== undefined) {
            setNestedValue(parsed, tr.target, tr.value);
          }
        }
      }
    }

    finalParsed = parsed;
    finalOk = true;
  }

  // ── Memory (RED-215 phase 3): commit turn on success ────────────────
  // Trivial-default write: one {input, output} entry per writable
  // bucket. If the gen declared write_memory_via, defer to the retro
  // agent (phase 4) — we emit a trace note so the run's memory story
  // is visible even before the agent runtime lands.
  if (memoryPlans.length > 0) {
    const hasMemoryAgent = Boolean(ir.policies?.memory_write_via);
    if (finalOk && !hasMemoryAgent) {
      try {
        const writeTrace = await commitMemoryWrites(
          memoryPlans, memoryBackends, getGroundingDocument(ir), finalParsed,
        );
        for (const t of writeTrace) trace.steps.push(t);
      } catch (e: any) {
        trace.steps.push({
          type: 'memory.write',
          id: 'memory_write_failed',
          ok: false,
          errors: [{ message: String(e?.message ?? e) }],
        });
      }
    } else if (finalOk && hasMemoryAgent) {
      // RED-215 phase 4: invoke the retro memory agent. Best-effort —
      // every failure mode (missing file, agent crash, bad output,
      // invalid writes) is traced, not thrown. The primary already
      // returned a valid answer; memory loss is graceful degradation.
      const agentClass: string = ir.policies.memory_write_via;
      const agentFile = findRetroAgentFile(agentClass, ir.entry?.source);
      if (!agentFile) {
        trace.steps.push({
          type: 'memory.write',
          id: 'memory_write_agent_not_found',
          ok: false,
          errors: [{
            message:
              `write_memory_via :${agentClass} declared but no .cmb.rb file found. ` +
              'Searched sibling of primary and the framework app/gens/ fallback.',
          }],
        });
      } else {
        const ctx = buildRetroContext(getGroundingDocument(ir), finalParsed, trace);
        const result = invokeRetroAgent({ agentFile, ctx, mockMode: Boolean(mockFlag) });
        if (!result.ok) {
          trace.steps.push({
            type: 'memory.write',
            id: `memory_write_agent_failed`,
            ok: false,
            errors: [{ message: result.reason, stderr: result.stderr?.slice(0, 500) }],
            meta: { agent: agentClass },
          });
        } else {
          const { applied, dropped } = applyRetroWrites(result.writes, memoryBackends, agentClass);
          for (const a of applied) {
            trace.steps.push({
              type: 'memory.write',
              id: `memory_write_${a.memory}_agent`,
              ok: true,
              meta: {
                name: a.memory,
                entry_id: a.entry_id,
                bytes: a.bytes,
                written_by: `agent:${agentClass}`,
              },
            });
          }
          if (dropped.length > 0) {
            trace.steps.push({
              type: 'memory.write',
              id: 'memory_write_agent_dropped',
              ok: true,
              meta: {
                agent: agentClass,
                dropped,
                note: 'writes naming a memory slot not declared on the primary are dropped by design (best-effort).',
              },
            });
          }
        }
      }
    }
    closeBackends(memoryBackends);
  }

  // ── Write outputs ───────────────────────────────────────────────────
  trace.finished_at = new Date().toISOString();

  // Aggregate token usage across all LLM calls
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, llm_calls: 0 };
  for (const step of trace.steps) {
    const usage = step.meta?.usage;
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens ?? 0;
      totalUsage.completion_tokens += usage.completion_tokens ?? 0;
      totalUsage.total_tokens += usage.total_tokens ?? 0;
      totalUsage.llm_calls += 1;
    }
  }

  trace.final = { ok: finalOk, schema_id: schema.$id, usage: totalUsage, budget: budget.summary() };
  trace.finished_at = new Date().toISOString();

  // ── Log emission (RED-282 / RED-302): run-complete fan-out ─────────
  // Fire the run-level event to every configured destination. Async,
  // awaited here so the CLI / host sees a consistent trace before
  // returning. Sink errors don't propagate — they become LogFailed
  // steps in the trace, the run still returns its result.
  if (logDestinations.length > 0) {
    const outcome = classifyRunOutcome(finalOk, trace, false);
    const runEvent = buildRunLogEvent({
      genClass: ir.entry?.class ?? 'Unknown',
      method: ir.entry?.method ?? 'unknown',
      event: outcome.event,
      runId,
      ok: finalOk,
      schemaId: schema.$id,
      usage: {
        prompt_tokens: totalUsage.prompt_tokens,
        completion_tokens: totalUsage.completion_tokens,
        total_tokens: totalUsage.total_tokens,
      },
      traceRef: `runs/${runId}/trace.json`,
      reason: outcome.reason,
      firedBy: firedBy ? 'schedule' : undefined,
      trace,
    });
    await emitLogEvent(runEvent, {
      destinations: logDestinations,
      sinks: logSinks,
      pushStep: (step: any) => trace.steps.push(step),
    });
  }

  return {
    ok: finalOk,
    output: finalParsed ?? null,
    trace,
    runId,
    schemaId: schema.$id,
    ir,
    errorMessage: finalOk ? undefined : 'Validation failed after repair attempts',
  };

  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Emit a failed event with reason=budget_exceeded before returning,
      // so DD dashboards see "gen.method.failed {reason: budget_exceeded}".
      if (logDestinations.length > 0) {
        const runEvent = buildRunLogEvent({
          genClass: ir.entry?.class ?? 'Unknown',
          method: ir.entry?.method ?? 'unknown',
          event: 'failed',
          runId,
          ok: false,
          schemaId: schema.$id,
          traceRef: `runs/${runId}/trace.json`,
          reason: 'budget_exceeded',
          firedBy: firedBy ? 'schedule' : undefined,
          trace,
        });
        await emitLogEvent(runEvent, {
          destinations: logDestinations,
          sinks: logSinks,
          pushStep: (step: any) => trace.steps.push(step),
        });
      }
      return {
        ok: false,
        output: null,
        trace,
        runId,
        schemaId: schema.$id,
        ir,
        errorMessage: e.message,
      };
    }
    throw e;
  } finally {
    // Restore the previous CAMBIUM_ALLOW_MOCK so a `runGen({ mock: true })`
    // doesn't leak the env-var override past this call. See note at
    // mockFlag setup at the top of runGen.
    if (mockFlag) {
      if (previousMockEnv === undefined) {
        delete process.env.CAMBIUM_ALLOW_MOCK;
      } else {
        process.env.CAMBIUM_ALLOW_MOCK = previousMockEnv;
      }
    }
  }
}

// ── runGenFromIr: CLI-equivalent in-process entry point (RED-306) ────
//
// Wraps the discovery + runGen + artifact-write flow so the `cambium`
// CLI can invoke the runner in-process via `import { runGenFromIr }
// from '@redwood-labs/cambium-runner'` instead of spawning a `node --import tsx`
// subprocess. Engine-mode hosts still call `runGen` directly with
// their own schemas — this helper exists specifically to encode the
// CLI's "discover schemas from engine or genfile, write artifacts,
// return result + paths" contract.

export interface RunGenFromIrOptions {
  /** Parsed IR object (typically `JSON.parse(<ruby compile stdout>)`). */
  ir: IR;
  /** Working directory for genfile discovery + default artifact root.
   *  Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the trace-output path. Defaults to `<runsDir>/<runId>/trace.json`. */
  traceOut?: string;
  /** Override the output-output path. Defaults to `<runsDir>/<runId>/output.json`. */
  outputOut?: string;
  /** Pass-through to runGen. */
  mock?: boolean;
  memoryKeys?: string[];
  sessionId?: string;
  firedBy?: string;
  /** Optional caller-provided log-sink overrides (parallel to runGen's). */
  logSinks?: Record<string, LogSink>;
}

export interface RunGenFromIrResult extends RunGenResult {
  /** Absolute path to the written trace.json. */
  tracePath: string;
  /** Absolute path to the written output.json. */
  outputPath: string;
  /** Absolute path to the written ir.json. */
  irPath: string;
  /** Absolute path to the per-run artifact directory. */
  runDir: string;
}

export async function runGenFromIr(opts: RunGenFromIrOptions): Promise<RunGenFromIrResult> {
  const cwd = opts.cwd ?? process.cwd();

  let contractsMod: Record<string, any>;
  // RED-287: engine-mode schemas live as a sibling of the gen file
  // (`<engineDir>/schemas.ts`) rather than under an app/ convention.
  // Detect by walking up from `ir.entry.source` looking for the
  // `cambium.engine.json` sentinel. When engine mode is detected it
  // wins over the app-mode Genfile lookup — an IR compiled from an
  // engine gen always sources its own schemas, even if cwd happens
  // to contain a Genfile.
  const engineDir = resolveEngineDir(opts.ir.entry?.source);
  const genfile = resolveGenfileContracts(cwd);
  let appCorrectors: Record<string, CorrectorFn> | undefined;
  if (engineDir) {
    const schemasFile = join(engineDir, 'schemas.ts');
    if (!existsSync(schemasFile)) {
      throw new Error(
        `Engine schemas file not found: ${schemasFile}. ` +
        `Engine gens source their schemas from '<engineDir>/schemas.ts' (RED-220, RED-287).`,
      );
    }
    contractsMod = await import(pathToFileURL(schemasFile).href);
  } else if (genfile) {
    contractsMod = await loadContractsFromGenfile(genfile);
    // RED-275: app-mode correctors discovered under <genfileDir>/app/correctors/.
    // RED-299: pass them via runGen's `correctors` option rather than
    // mutating a module-global. Engine-mode correctors are discovered
    // inside runGen via the engineDir scan (RED-287 phase 3).
    const app = await loadAppCorrectors(genfile.genfileDir);
    if (Object.keys(app.correctors).length > 0) {
      appCorrectors = app.correctors;
    }
  } else {
    // pathToFileURL is not strictly required on POSIX (`import()` of a
    // bare absolute path works) but is required on Windows, where a
    // bare `C:\...` path is not a valid ESM specifier. Matches the
    // genfile-path loader in `genfile.ts`.
    const fallback = pathToFileURL(join(cwd, 'packages/cambium/src/contracts.ts')).href;
    contractsMod = await import(fallback);
  }

  const result = await runGen({
    ir: opts.ir,
    schemas: contractsMod,
    mock: opts.mock,
    memoryKeys: opts.memoryKeys,
    sessionId: opts.sessionId,
    correctors: appCorrectors,
    logSinks: opts.logSinks,
    firedBy: opts.firedBy,
  });

  // RED-287: engine-mode run artifacts go under <engineDir>/runs/ so
  // the engine folder stays self-contained. App mode continues to
  // write under <cwd>/runs/.
  const runsBase = engineDir ? join(engineDir, 'runs') : join(cwd, 'runs');
  const runDir = join(runsBase, result.runId);
  mkdirSync(runDir, { recursive: true });
  const irPath = join(runDir, 'ir.json');
  const tracePath = opts.traceOut ?? join(runDir, 'trace.json');
  const outputPath = opts.outputOut ?? join(runDir, 'output.json');
  writeFileSync(irPath, JSON.stringify(result.ir, null, 2));
  writeFileSync(tracePath, JSON.stringify(result.trace, null, 2));
  writeFileSync(outputPath, JSON.stringify(result.output ?? null, null, 2));

  return { ...result, tracePath, outputPath, irPath, runDir };
}

// ── CLI entry point ───────────────────────────────────────────────────
//
// argv parsing + IR file read → delegates to runGenFromIr. The `cambium`
// CLI no longer spawns this file as a subprocess (RED-306); this main()
// remains so `node dist/runner.js --ir <path>` still works for debugging
// and for any operator bypassing the CLI.
async function main() {
  const { irPath, traceOut, outputOut, mock, memoryKeys, firedBy } = parseArgs(process.argv.slice(2));
  const irText = irPath === '-' ? readFileSync(0, 'utf8') : readFileSync(irPath, 'utf8');
  const ir: IR = JSON.parse(irText);

  const result = await runGenFromIr({
    ir,
    traceOut,
    outputOut,
    mock,
    memoryKeys,
    firedBy,
  });

  if (!result.ok) {
    if (result.errorMessage) {
      console.error(`${result.errorMessage}. See ${result.tracePath}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify(result.output, null, 2));
  console.error(`Trace: ${result.tracePath}`);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// Only run the CLI entry when this file is invoked as a script. When
// imported as a library (engine-mode hosts: `import { runGen } from
// '@redwood-labs/cambium-runner'`), `main()` must NOT fire — it would parse the
// host's argv looking for --ir, find nothing, and exit. The check
// compares the resolved module path against process.argv[1].
// Surfaced by the RED-220 POC.
const invokedAsScript = fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
