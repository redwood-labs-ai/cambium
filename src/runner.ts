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

async function ollamaGenerate(opts: { model: string; system: string; prompt: string; max_tokens?: number; temperature?: number; }): Promise<string> {
  const body = {
    model: opts.model.replace(/^ollama:/, ''),
    prompt: `${opts.system}\n\n${opts.prompt}`,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.max_tokens ?? 1200,
    }
  };

  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Ollama error: HTTP ${res.status}`);
    const json: any = await res.json();
    return json.response as string;
  } catch (err: any) {
    // Allow a deterministic mock for local development when Ollama isn't running.
    if (process.env.CAMBIUM_ALLOW_MOCK === '1') {
      return mockGenerate(opts.prompt);
    }
    const hint = "Ollama fetch failed. Start Ollama (`ollama serve`) or set CAMBIUM_ALLOW_MOCK=1 for deterministic mock output.";
    throw new Error(`${hint}\nOriginal error: ${err?.message ?? String(err)}`);
  }
}

function mockGenerate(prompt: string): string {
  const matches = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*ms\b/gi)].map(m => Number(m[1]));
  const payload = {
    summary: 'Mock analysis (Ollama not available).',
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

  const system = [
    'You are a professional analyst.',
    'Return ONLY valid JSON. No markdown. No code fences.',
    `The JSON MUST validate against schema id: ${schema.$id}.`,
    'If you are unsure, use empty strings/empty arrays, but still satisfy the schema.'
  ].join(' ');

  const prompt = `${genStep.prompt}\n\nDOCUMENT:\n${doc}`;

  const started = Date.now();
  let raw = await ollamaGenerate({
    model: ir.model.id,
    system,
    prompt,
    max_tokens: ir.model.max_tokens,
    temperature: ir.model.temperature
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
      'Return ONLY valid JSON. No markdown. No code fences.',
      'Edit ONLY the fields necessary to fix the validation errors.',
      `Schema id: ${schema.$id}.`
    ].join(' ');

    const repairPrompt = [
      'ORIGINAL_JSON:',
      raw,
      '',
      'VALIDATION_ERRORS:',
      JSON.stringify(errors, null, 2),
      '',
      'Return repaired JSON only.'
    ].join('\n');

    const rStarted = Date.now();
    raw = await ollamaGenerate({ model: ir.model.id, system: repairSystem, prompt: repairPrompt, max_tokens: ir.model.max_tokens, temperature: ir.model.temperature });
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
