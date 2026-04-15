import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
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
import { runReview, runConsensus } from './compound.js';
import { runEnrichment } from './enrich.js';
import { parseBudget, trackBudgetFromTraceStep } from './budget.js';
import type { Budget } from './budget.js';
import {
  parseInlineToolCalls,
  stripInlineToolCalls,
  type ToolCallMessage,
} from './inline-tool-calls.js';

type IR = any;

type Args = { irPath: string; traceOut?: string; outputOut?: string; mock?: boolean };

function parseArgs(argv: string[]): Args {
  let irPath: string | null = null;
  let traceOut: string | undefined;
  let outputOut: string | undefined;
  let mock = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ir') irPath = argv[++i];
    else if (a === '--trace') traceOut = argv[++i];
    else if (a === '--out') outputOut = argv[++i];
    else if (a === '--mock') { mock = true; process.env.CAMBIUM_ALLOW_MOCK = '1'; }
    else if (a === '--help' || a === '-h') {
      console.error(`
Cambium Runner — step-graph executor

Usage:
  node --import tsx src/runner.ts --ir <path|-  [--trace <path>] [--out <path>] [--mock]

Flags:
  --ir <path>      IR JSON file, or '-' for stdin
  --trace <path>   Write trace JSON to <path> (default: runs/<id>/trace.json)
  --out <path>     Write output JSON to <path> (default: runs/<id>/output.json)
  --mock           Use deterministic mock instead of live LLM
  --help, -h       Show this help

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
  return { irPath, traceOut, outputOut, mock };
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

  if (provider !== 'omlx') {
    throw new Error(`Agentic mode requires oMLX provider (OpenAI-compatible). Got: ${provider}`);
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

function mockGenerate(prompt: string): string {
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

// ── Main: Step-Graph Executor ─────────────────────────────────────────
async function main() {
  const { irPath, traceOut, outputOut } = parseArgs(process.argv.slice(2));
  const irText = irPath === '-' ? readFileSync(0, 'utf8') : readFileSync(irPath, 'utf8');
  const ir: IR = JSON.parse(irText);

  const runId = `run_${nowId()}_${Math.random().toString(16).slice(2, 8)}`;
  const runDir = join(process.cwd(), 'runs', runId);
  mkdirSync(runDir, { recursive: true });

  const trace: any = {
    run_id: runId,
    version: ir.version,
    entry: ir.entry,
    model: ir.model,
    steps: [],
    started_at: new Date().toISOString(),
  };

  // ── Load contracts ──────────────────────────────────────────────────
  const contractsMod: any = await import(join(process.cwd(), 'packages/cambium/src/contracts.ts'));
  const schema = contractsMod[ir.returnSchemaId];
  if (!schema) throw new Error(`Schema not found in contracts.ts for id: ${ir.returnSchemaId}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(schema, schema.$id);
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`AJV schema not registered: ${schema.$id}`);

  // ── Load tool registry ──────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  await toolRegistry.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'));

  const toolsAllowed: string[] = ir.policies?.tools_allowed ?? [];
  // Validate that all declared tools exist in the registry
  for (const t of toolsAllowed) {
    if (!toolRegistry.get(t)) {
      throw new Error(`Tool "${t}" declared in policies.tools_allowed but not found in registry. Available: ${toolRegistry.list().join(', ')}`);
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

  const correctorNames: string[] = ir.policies?.correctors ?? [];
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
      writeFileSync(join(runDir, 'ir.json'), JSON.stringify(ir, null, 2));
      writeFileSync(traceOut ?? join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
      writeFileSync(outputOut ?? join(runDir, 'output.json'), 'null');
      console.error(`Budget exceeded: ${violation.message}. See ${traceOut ?? join('runs', runId, 'trace.json')}`);
      process.exit(1);
    }
  }

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
      trace.steps.push(repair.result);
      budgetTrack(repair.result);
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
        trace.steps.push(repair.result);
        budgetTrack(repair.result);

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
          trace.steps.push(repair.result);

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

    // 4. Correctors (deterministic post-validation transforms)
    if (correctorNames.length > 0) {
      const correctResult = handleCorrect(parsed, correctorNames, { document: ir.context?.document });
      trace.steps.push(correctResult);

      if (correctResult.meta?.corrected) {
        parsed = correctResult.output;

        // Re-validate after correction to ensure correctors didn't break schema
        const revalidate = handleValidate(parsed, validate, 'ValidateAfterCorrect');
        if (!revalidate.ok) {
          trace.steps.push(revalidate);
          finalOk = false;
          break;
        }
      }
    }

    // 5. Grounding: citation enforcement (auto-registered when grounded_in is declared)
    const grounding = ir.policies?.grounding;
    if (grounding?.require_citations) {
      const citResult = handleCorrect(parsed, ['citations'], { document: ir.context?.document });
      const citationResult = citResult.meta?.citationResult;

      trace.steps.push({
        ...citResult,
        type: 'GroundingCheck',
        ok: citationResult?.allValid ?? (citResult.issues.length === 0),
        meta: {
          ...citResult.meta,
          passed: citationResult?.passed?.length ?? 0,
          failed: citationResult?.failed?.length ?? 0,
          missing: citationResult?.missing?.length ?? 0,
          totalChecked: citationResult?.totalChecked ?? 0,
          details: citationResult?.failed ?? [],
        },
      });

      const citErrors = citResult.issues?.filter((i: any) => i.severity === 'error') ?? [];
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
        trace.steps.push(repair.result);

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
        const triggerResults = evaluateTriggers(triggerDefs, state, toolRegistry, toolsAllowed, {
          policy: securityPolicy, budget, traceEvents: trace.steps,
        });
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

  writeFileSync(join(runDir, 'ir.json'), JSON.stringify(ir, null, 2));
  writeFileSync(traceOut ?? join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
  writeFileSync(outputOut ?? join(runDir, 'output.json'), JSON.stringify(finalParsed ?? null, null, 2));

  if (!finalOk) {
    console.error(`Validation failed after repair attempts. See ${traceOut ?? join('runs', runId, 'trace.json')}`);
    process.exit(1);
  }

  console.log(JSON.stringify(finalParsed, null, 2));
  console.error(`Trace: ${traceOut ?? join('runs', runId, 'trace.json')}`);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
