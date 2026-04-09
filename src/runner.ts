import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import Ajv from 'ajv';
import { ToolRegistry } from './tools/registry.js';
import {
  handleGenerate,
  handleValidate,
  handleRepair,
  handleCorrect,
} from './step-handlers.js';
import { extractSignals } from './signals.js';
import { evaluateTriggers } from './triggers.js';

type IR = any;

type Args = { irPath: string };

function parseArgs(argv: string[]): Args {
  let irPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ir') irPath = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!irPath) throw new Error('Missing --ir');
  return { irPath };
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

async function generateText(opts: { model: string; system: string; prompt: string; max_tokens?: number; temperature?: number; jsonSchema?: any; }): Promise<string> {
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
      return json.response as string;
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
      return content as string;
    }

    throw new Error(`Unknown model provider: ${provider}`);
  } catch (err: any) {
    // Allow a deterministic mock for local development when the provider isn't reachable.
    if (process.env.CAMBIUM_ALLOW_MOCK === '1') {
      return mockGenerate(opts.prompt);
    }
    const hint = provider === 'omlx'
      ? 'oMLX fetch failed. Check CAMBIUM_OMLX_BASEURL (default http://100.114.183.54:8080) and server status.'
      : 'Ollama fetch failed. Start Ollama (`ollama serve`).';
    throw new Error(`${hint}\nOriginal error: ${err?.message ?? String(err)}`);
  }
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
  const { irPath } = parseArgs(process.argv.slice(2));
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
  toolRegistry.loadFromDir(join(process.cwd(), 'packages/cambium/app/tools'));

  const toolsAllowed: string[] = ir.policies?.tools_allowed ?? [];
  // Validate that all declared tools exist in the registry
  for (const t of toolsAllowed) {
    if (!toolRegistry.get(t)) {
      throw new Error(`Tool "${t}" declared in policies.tools_allowed but not found in registry. Available: ${toolRegistry.list().join(', ')}`);
    }
  }

  const correctorNames: string[] = ir.policies?.correctors ?? [];
  const maxRepairAttempts = ir.policies?.max_repair_attempts ?? 2;

  // ── Execute IR steps ────────────────────────────────────────────────
  let finalParsed: any = undefined;
  let finalOk = false;

  for (const step of ir.steps) {
    if (step.type !== 'Generate') {
      trace.steps.push({ type: step.type, id: step.id, ok: false, errors: [{ message: `Unknown step type: ${step.type}` }] });
      continue;
    }

    // ── Sub-pipeline: Generate → Validate → Repair → Correct → ToolCall → Return ──

    // 1. Generate
    const gen = await handleGenerate(step, ir, schema, generateText, extractJsonObject);
    trace.steps.push(gen.result);

    let raw = gen.raw;
    let parsed = gen.parsed;

    // 2. Validate + Repair loop
    let ok = false;
    let errors: any[] = [];

    for (let attempt = 0; attempt < 1 + maxRepairAttempts; attempt++) {
      const vResult = handleValidate(parsed, validate, attempt === 0 ? 'Validate' : 'ValidateAfterRepair');

      if (vResult.ok) {
        ok = true;
        errors = [];
        // Only push validate step on success if it wasn't first attempt (show the win after repair)
        if (attempt > 0) trace.steps.push(vResult);
        break;
      }

      errors = vResult.errors ?? [];
      trace.steps.push(vResult);

      // Don't repair after last attempt
      if (attempt >= maxRepairAttempts) break;

      // Repair
      const repair = await handleRepair(raw, errors, schema, ir, attempt + 1, generateText, extractJsonObject);
      trace.steps.push(repair.result);
      raw = repair.raw;
      parsed = repair.parsed;
    }

    if (!ok) {
      finalOk = false;
      break;
    }

    // 3. Correctors (deterministic post-validation transforms)
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

    // 4. Signals + Triggers (general-purpose tool dispatch)
    const signalDefs = ir.signals ?? [];
    const triggerDefs = ir.triggers ?? [];

    if (signalDefs.length > 0) {
      const state = extractSignals(parsed, signalDefs);
      trace.steps.push({ type: 'ExtractSignals', ok: true, meta: { state } });

      if (triggerDefs.length > 0) {
        const triggerResults = evaluateTriggers(triggerDefs, state, toolRegistry, toolsAllowed);
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
  trace.final = { ok: finalOk, schema_id: schema.$id };

  writeFileSync(join(runDir, 'ir.json'), JSON.stringify(ir, null, 2));
  writeFileSync(join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
  writeFileSync(join(runDir, 'output.json'), JSON.stringify(finalParsed ?? null, null, 2));

  if (!finalOk) {
    console.error(`Validation failed after repair attempts. See ${join('runs', runId, 'trace.json')}`);
    process.exit(1);
  }

  console.log(JSON.stringify(finalParsed, null, 2));
  console.error(`Trace: ${join('runs', runId, 'trace.json')}`);
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
