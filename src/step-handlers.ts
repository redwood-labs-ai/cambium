import type { ValidateFunction } from 'ajv';
import { ToolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/index.js';
import { runCorrectorPipeline } from './correctors/index.js';
import type { CorrectorResult } from './correctors/types.js';

export type StepResult = {
  type: string;
  id?: string;
  ms?: number;
  ok: boolean;
  output?: any;
  errors?: any[];
  meta?: Record<string, any>;
};

// ── Generate ──────────────────────────────────────────────────────────
export type GenerateTextFn = (opts: {
  model: string;
  system: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  jsonSchema?: any;
}) => Promise<string>;

export type ExtractJsonFn = (text: string) => any;

export async function handleGenerate(
  step: any,
  ir: any,
  schema: any,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
): Promise<{ raw: string; parsed: any; result: StepResult }> {
  const doc = ir.context?.document;
  const constraints = ir.policies?.constraints ?? {};

  // Derive system prompt from IR metadata instead of hardcoding
  const toneConstraint = constraints.tone?.to;
  const roleLine = toneConstraint
    ? `You are a ${toneConstraint} analyst.`
    : 'You are an analyst.';

  const schemaKeys = Object.keys(schema.properties ?? {});

  const system = [
    roleLine,
    'CRITICAL OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences.',
    '- Do NOT include any reasoning, thoughts, or preambles (no "Thinking" / "Thinking Process").',
    '- Output must start with "{" and end with "}".',
    `- JSON MUST validate against schema id: ${schema.$id}.`,
    `- Use exactly these top-level keys: ${schemaKeys.join(', ')}.`,
    '- If unsure, leave fields empty but valid.',
    'DATA EXTRACTION RULES:',
    '- For array fields, extract ALL matching values from the document. Do not summarize or omit.',
    '- Do not drop data points. If the document has 4 measurements, the array must have 4 entries.',
  ].join('\n');

  // Build a JSON template from schema properties
  const jsonTemplate: Record<string, any> = {};
  for (const key of schemaKeys) {
    const prop = schema.properties[key];
    if (prop.type === 'string') jsonTemplate[key] = '';
    else if (prop.type === 'array') jsonTemplate[key] = [];
    else if (prop.type === 'object') jsonTemplate[key] = {};
    else jsonTemplate[key] = null;
  }

  const prompt = [
    step.prompt,
    '',
    'DOCUMENT:',
    String(doc ?? ''),
    '',
    'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
    JSON.stringify(jsonTemplate),
  ].join('\n');

  const outMax = Math.min(Number(ir.model.max_tokens ?? 1200), 500);
  const started = Date.now();

  const raw = await generateText({
    model: ir.model.id,
    system,
    prompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    jsonSchema: schema,
  });

  let parsed: any = undefined;
  let parseError: string | undefined;
  try {
    parsed = extractJson(raw);
  } catch (e: any) {
    parseError = e.message;
  }

  return {
    raw,
    parsed,
    result: {
      type: 'Generate',
      id: step.id,
      ms: Date.now() - started,
      ok: parsed !== undefined,
      errors: parseError ? [{ message: parseError }] : undefined,
      meta: { raw_preview: raw.slice(0, 400) },
    },
  };
}

// ── Validate ──────────────────────────────────────────────────────────
export function handleValidate(
  data: any,
  validate: ValidateFunction,
  label?: string,
): StepResult {
  if (data === undefined) {
    return { type: label ?? 'Validate', ok: false, errors: [{ message: 'No data to validate' }] };
  }
  const ok = validate(data) as boolean;
  return {
    type: label ?? 'Validate',
    ok,
    errors: ok ? undefined : validate.errors?.map(e => ({ ...e })),
  };
}

// ── Repair ────────────────────────────────────────────────────────────
export async function handleRepair(
  raw: string,
  errors: any[],
  schema: any,
  ir: any,
  attempt: number,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
): Promise<{ raw: string; parsed: any; result: StepResult }> {
  const schemaKeys = Object.keys(schema.properties ?? {});

  // Build template same as generate
  const jsonTemplate: Record<string, any> = {};
  for (const key of schemaKeys) {
    const prop = schema.properties[key];
    if (prop.type === 'string') jsonTemplate[key] = '';
    else if (prop.type === 'array') jsonTemplate[key] = [];
    else if (prop.type === 'object') jsonTemplate[key] = {};
    else jsonTemplate[key] = null;
  }

  const repairSystem = [
    'You are repairing JSON to satisfy a schema.',
    'CRITICAL OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences.',
    '- Do NOT include reasoning or preambles.',
    '- Output must start with "{" and end with "}".',
    '- Edit ONLY the fields necessary to fix the validation errors.',
    `- Schema id: ${schema.$id}.`,
    `- Use exactly these top-level keys: ${schemaKeys.join(', ')}.`,
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
    'Return repaired JSON only.',
  ].join('\n');

  const outMax = Math.min(Number(ir.model.max_tokens ?? 1200), 500);
  const started = Date.now();

  const newRaw = await generateText({
    model: ir.model.id,
    system: repairSystem,
    prompt: repairPrompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    jsonSchema: schema,
  });

  let parsed: any = undefined;
  try {
    parsed = extractJson(newRaw);
  } catch {
    // will be caught by validation
  }

  return {
    raw: newRaw,
    parsed,
    result: {
      type: 'Repair',
      ms: Date.now() - started,
      ok: parsed !== undefined,
      meta: { attempt, raw_preview: newRaw.slice(0, 400) },
    },
  };
}

// ── Correct ───────────────────────────────────────────────────────────
export function handleCorrect(
  data: any,
  correctorNames: string[],
  context: { document?: string },
): StepResult {
  const started = Date.now();
  const { data: corrected, results } = runCorrectorPipeline(correctorNames, data, context);
  const anyCorrected = results.some(r => r.corrected);
  const allIssues = results.flatMap(r => r.issues);

  return {
    type: 'Correct',
    ms: Date.now() - started,
    ok: true,
    output: corrected,
    meta: {
      correctors: correctorNames,
      corrected: anyCorrected,
      issues: allIssues,
    },
  };
}

// ── ToolCall ──────────────────────────────────────────────────────────
export function handleToolCall(
  toolName: string,
  operation: string,
  input: any,
  registry: ToolRegistry,
  allowlist: string[],
): StepResult {
  const started = Date.now();

  registry.assertAllowed(toolName, allowlist);

  const def = registry.get(toolName);
  if (!def) throw new Error(`Tool "${toolName}" not found in registry. Available: ${registry.list().join(', ')}`);

  const impl = builtinTools[toolName];
  if (!impl) throw new Error(`No built-in implementation for tool "${toolName}"`);

  const result = impl(input);

  return {
    type: 'ToolCall',
    ms: Date.now() - started,
    ok: true,
    output: result,
    meta: { tool: toolName, operation, input, output: result },
  };
}
