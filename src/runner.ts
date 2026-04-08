import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import Ajv from 'ajv';

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

      const body: any = {
        model: name,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1200,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt }
        ]
      };

      // Structured output (vLLM-compatible) — requires xgrammar enabled on the server.
      // oMLX release notes mention `structured_outputs` support; vLLM docs widely support `guided_json`.
      if (opts.jsonSchema && (process.env.CAMBIUM_OMLX_GUIDED_JSON ?? '1') === '1') {
        body.extra_body = {
          guided_json: opts.jsonSchema
        };
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

function extractJsonObject(text: string): any {
  // v0.1: naive JSON extraction: find first '{' and last '}'
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in model output');
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}

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

  // Load TypeBox contracts compiled at runtime by importing the genesis package TS.
  // v0.1 shortcut: dynamic import of the contracts file. (This is why runner is TS with tsx loader.)
  const contractsMod: any = await import(join(process.cwd(), 'packages/cambium/src/contracts.ts'));
  const schema = contractsMod[ir.returnSchemaId];
  if (!schema) throw new Error(`Schema not found in contracts.ts for id: ${ir.returnSchemaId}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(schema, schema.$id);
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`AJV schema not registered: ${schema.$id}`);

  const doc = ir.context?.document;

  const genStep = ir.steps.find((s: any) => s.type === 'Generate');
  if (!genStep) throw new Error('IR missing Generate step');

  const jsonTemplate = {
    summary: "",
    metrics: { latency_ms_samples: [] as number[] },
    key_facts: [] as any[]
  };

  const system = [
    'You are a professional analyst.',
    'CRITICAL OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences.',
    '- Do NOT include any reasoning, thoughts, or preambles (no "Thinking" / "Thinking Process").',
    '- Output must start with "{" and end with "}".',
    `- JSON MUST validate against schema id: ${schema.$id}.`,
    '- Do not invent extra top-level keys. Use exactly: summary, metrics, key_facts.',
    '- If unsure, leave fields empty but valid.'
  ].join('\n');

  const prompt = [
    `${genStep.prompt}`,
    '',
    'DOCUMENT:',
    String(doc ?? ''),
    '',
    'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
    JSON.stringify(jsonTemplate),
  ].join('\n');

  const started = Date.now();
  // v0.1: cap output tokens to reduce rambling/truncation risk.
  const outMax = Math.min(Number(ir.model.max_tokens ?? 1200), 500);

  let raw = await generateText({
    model: ir.model.id,
    system,
    prompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    jsonSchema: schema
  });
  trace.steps.push({ id: genStep.id, type: 'Generate', ms: Date.now() - started, raw_preview: raw.slice(0, 400) });

  let parsed: any;
  let ok = false;
  let errors: any[] = [];

  for (let attempt = 0; attempt < 1 + (ir.policies?.max_repair_attempts ?? 2); attempt++) {
    try {
      parsed = extractJsonObject(raw);
    } catch (e: any) {
      errors = [{ message: e.message }];
      ok = false;
    }

    if (parsed && validate(parsed)) {
      ok = true;
      errors = [];
      break;
    }

    ok = false;
    errors = validate.errors ? validate.errors.map(e => ({ ...e })) : errors;

    trace.steps.push({ type: attempt === 0 ? 'Validate' : 'ValidateAfterRepair', ok: false, errors });

    // Repair
    const repairSystem = [
      'You are repairing JSON to satisfy a schema.',
      'CRITICAL OUTPUT RULES:',
      '- Output MUST be JSON only. No markdown. No code fences.',
      '- Do NOT include reasoning or preambles.',
      '- Output must start with "{" and end with "}".',
      '- Edit ONLY the fields necessary to fix the validation errors.',
      `- Schema id: ${schema.$id}.`,
      '- Do not add extra top-level keys. Use exactly: summary, metrics, key_facts.'
    ].join('\n');

    const repairPrompt = [
      'ORIGINAL_OUTPUT (may be invalid):',
      raw,
      '',
      'VALIDATION_ERRORS:',
      JSON.stringify(errors, null, 2),
      '',
      'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; no extra keys):',
      JSON.stringify(jsonTemplate),
      '',
      'Return repaired JSON only.'
    ].join('\n');

    const rStarted = Date.now();
    raw = await generateText({ model: ir.model.id, system: repairSystem, prompt: repairPrompt, max_tokens: outMax, temperature: ir.model.temperature, jsonSchema: schema });
    trace.steps.push({ type: 'Repair', attempt: attempt + 1, ms: Date.now() - rStarted, raw_preview: raw.slice(0, 400) });
  }

  // Deterministic post-step tool: calculator for avg latency.
  if (ok && parsed?.metrics?.latency_ms_samples?.length && parsed.metrics.avg_latency_ms == null) {
    const samples: number[] = parsed.metrics.latency_ms_samples;
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    parsed.metrics.avg_latency_ms = Math.round(avg * 1000) / 1000;
    trace.steps.push({ type: 'ToolCall', tool: 'calculator(avg)', input: samples, output: parsed.metrics.avg_latency_ms });
  }

  trace.finished_at = new Date().toISOString();
  trace.final = { ok, schema_id: schema.$id };

  writeFileSync(join(runDir, 'ir.json'), JSON.stringify(ir, null, 2));
  writeFileSync(join(runDir, 'trace.json'), JSON.stringify(trace, null, 2));
  writeFileSync(join(runDir, 'output.json'), JSON.stringify(parsed ?? null, null, 2));

  if (!ok) {
    console.error(`Validation failed after repair attempts. See ${join('runs', runId, 'trace.json')}`);
    process.exit(1);
  }

  console.log(JSON.stringify(parsed, null, 2));
  console.error(`Trace: ${join('runs', runId, 'trace.json')}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
