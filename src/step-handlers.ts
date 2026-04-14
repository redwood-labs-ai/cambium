import type { ValidateFunction } from 'ajv';
import { ToolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/index.js';
import { runCorrectorPipeline } from './correctors/index.js';
import type { CorrectorResult } from './correctors/types.js';
import { schemaPromptBlock } from './schema-describe.js';
import { parseInlineToolCalls, stripInlineToolCalls } from './inline-tool-calls.js';

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
export type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type GenerateTextResult = { text: string; usage?: TokenUsage };

export type GenerateTextFn = (opts: {
  model: string;
  system: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  jsonSchema?: any;
}) => Promise<GenerateTextResult>;

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
  const schemaKeys = Object.keys(schema.properties ?? {});

  // System prompt: use author-defined prompt from IR, or fall back to a generic one.
  const basePrompt = ir.system
    ?? (constraints.tone?.to ? `You are a ${constraints.tone.to} analyst.` : 'You are an analyst.');

  const grounding = ir.policies?.grounding;

  const systemParts = [
    basePrompt,
    '',
    schemaPromptBlock(schema),
    '',
    'OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
    '- Output must start with "{" and end with "}".',
    '- If unsure, leave fields empty but valid.',
  ];

  if (grounding?.require_citations) {
    systemParts.push(
      '',
      'GROUNDING RULES:',
      '- Every item in arrays with a citations field MUST include citations.',
      '- Each citation MUST include a quote field with EXACT verbatim text from the document.',
      '- Do not paraphrase or fabricate quotes. Copy text exactly as it appears.',
    );
  }

  const system = systemParts.join('\n');

  // Build a JSON template from schema properties
  const jsonTemplate: Record<string, any> = {};
  for (const key of schemaKeys) {
    const prop = schema.properties[key];
    if (prop.type === 'string') jsonTemplate[key] = '';
    else if (prop.type === 'array') jsonTemplate[key] = [];
    else if (prop.type === 'object') jsonTemplate[key] = {};
    else jsonTemplate[key] = null;
  }

  // Build prompt with document + any enriched context
  const promptParts = [
    step.prompt,
    '',
    'DOCUMENT:',
    String(doc ?? ''),
  ];

  // Include enriched context fields (added by the enrich primitive)
  const context = ir.context ?? {};
  for (const key of Object.keys(context)) {
    if (key.endsWith('_enriched')) {
      const label = key.replace(/_enriched$/, '').toUpperCase() + '_ANALYSIS';
      const value = typeof context[key] === 'string' ? context[key] : JSON.stringify(context[key], null, 2);
      promptParts.push('', `${label}:`, value);
    }
  }

  promptParts.push(
    '',
    'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
    JSON.stringify(jsonTemplate),
  );

  const prompt = promptParts.join('\n');

  const outMax = Number(ir.model.max_tokens ?? 1200);
  const started = Date.now();

  const genResult = await generateText({
    model: ir.model.id,
    system,
    prompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    jsonSchema: schema,
  });

  const raw = genResult.text;
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
      meta: { model_used: ir.model.id, raw_preview: raw.slice(0, 400), usage: genResult.usage },
    },
  };
}

// ── Validate ──────────────────────────────────────────────────────────

/** Format AJV validation errors into a concise diff for trace + repair prompts. */
export function formatValidationErrors(errors: any[]): string[] {
  return errors.map(e => {
    const path = e.instancePath || '/';
    const keyword = e.keyword ?? 'validation';

    if (keyword === 'required') {
      const prefix = path === '/' ? '' : path;
      return `missing required field: ${prefix}/${e.params?.missingProperty}`;
    }
    if (keyword === 'additionalProperties') {
      const prefix = path === '/' ? '' : path;
      return `unexpected field: ${prefix}/${e.params?.additionalProperty}`;
    }
    if (keyword === 'type') {
      return `${path}: expected ${e.params?.type}, got ${typeof e.instance}`;
    }
    if (keyword === 'enum') {
      return `${path}: value must be one of [${e.params?.allowedValues?.join(', ')}]`;
    }
    if (keyword === 'pattern') {
      return `${path}: does not match pattern ${e.params?.pattern}`;
    }
    if (keyword === 'minLength') {
      return `${path}: too short (min ${e.params?.limit})`;
    }
    if (keyword === 'maxLength') {
      return `${path}: too long (max ${e.params?.limit})`;
    }
    // Fallback
    return `${path}: ${e.message ?? keyword}`;
  });
}

export function handleValidate(
  data: any,
  validate: ValidateFunction,
  label?: string,
): StepResult {
  if (data === undefined) {
    return { type: label ?? 'Validate', ok: false, errors: [{ message: 'No data to validate' }] };
  }
  const ok = validate(data) as boolean;
  const rawErrors = ok ? undefined : validate.errors?.map(e => ({ ...e }));
  return {
    type: label ?? 'Validate',
    ok,
    errors: rawErrors,
    meta: ok ? undefined : { validation_diff: formatValidationErrors(rawErrors ?? []) },
  };
}

// ── Repair ────────────────────────────────────────────────────────────
function buildJsonTemplate(schema: any): Record<string, any> {
  const schemaKeys = Object.keys(schema.properties ?? {});
  const jsonTemplate: Record<string, any> = {};
  for (const key of schemaKeys) {
    const prop = schema.properties[key];
    if (prop.type === 'string') jsonTemplate[key] = '';
    else if (prop.type === 'array') jsonTemplate[key] = [];
    else if (prop.type === 'object') jsonTemplate[key] = {};
    else jsonTemplate[key] = null;
  }
  return jsonTemplate;
}

function looksLikeToolCallMarkup(raw: string): boolean {
  return /<\|tool_call>|<tool_call>/.test(raw);
}

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

  const jsonTemplate = buildJsonTemplate(schema);

  // If the "raw" output is actually tool-call markup, do NOT hallucinate a placeholder answer.
  // Fail closed by returning an empty-but-valid JSON object (the agent loop should handle tools).
  if (looksLikeToolCallMarkup(raw)) {
    const started = Date.now();
    const emptyRaw = JSON.stringify(jsonTemplate);
    return {
      raw: emptyRaw,
      parsed: jsonTemplate,
      result: {
        type: 'Repair',
        ms: Date.now() - started,
        ok: true,
        meta: {
          attempt,
          deterministic: true,
          reason: 'tool_call_markup',
          raw_preview: raw.slice(0, 200),
        },
      },
    };
  }

  const repairSystem = [
    'You are repairing JSON to satisfy a schema.',
    '',
    schemaPromptBlock(schema),
    '',
    'OUTPUT RULES:',
    '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
    '- Output must start with "{" and end with "}".',
    '- Edit ONLY the fields necessary to fix the validation errors.',
    '- Do NOT introduce new factual content. If information is missing, leave the field empty.',
  ].join('\n');

  const formattedErrors = formatValidationErrors(errors);

  const repairPrompt = [
    'ORIGINAL_OUTPUT (may be invalid):',
    raw,
    '',
    'VALIDATION_ERRORS:',
    formattedErrors.join('\n'),
    '',
    'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; no extra keys):',
    JSON.stringify(jsonTemplate),
    '',
    'Return repaired JSON only.',
  ].join('\n');

  const outMax = Number(ir.model.max_tokens ?? 1200);
  const started = Date.now();

  const genResult = await generateText({
    model: ir.model.id,
    system: repairSystem,
    prompt: repairPrompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    jsonSchema: schema,
  });

  const newRaw = genResult.text;
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
      meta: { attempt, model_used: ir.model.id, raw_preview: newRaw.slice(0, 400), usage: genResult.usage },
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
export async function handleToolCall(
  toolName: string,
  operation: string,
  input: any,
  registry: ToolRegistry,
  allowlist: string[],
): Promise<StepResult> {
  const started = Date.now();

  registry.assertAllowed(toolName, allowlist);

  const def = registry.get(toolName);
  if (!def) throw new Error(`Tool "${toolName}" not found in registry. Available: ${registry.list().join(', ')}`);

  const impl = builtinTools[toolName];
  if (!impl) throw new Error(`No built-in implementation for tool "${toolName}"`);

  // Support both sync and async tool implementations
  const result = await Promise.resolve(impl(input));

  return {
    type: 'ToolCall',
    ms: Date.now() - started,
    ok: true,
    output: result,
    meta: { tool: toolName, operation, input, output: result },
  };
}

// ── Agentic Generate (multi-turn tool-use loop) ──────────────────────

type Message = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string };
type ToolCallMsg = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type GenerateWithToolsFn = (opts: {
  model: string;
  messages: Message[];
  tools: any[];
  max_tokens?: number;
  temperature?: number;
}) => Promise<{ message: { content: string | null; tool_calls?: ToolCallMsg[] }; usage?: TokenUsage }>;

export async function handleAgenticGenerate(
  step: any,
  ir: any,
  schema: any,
  toolsOpenAI: any[],
  toolRegistry: ToolRegistry,
  toolsAllowed: string[],
  generateWithTools: GenerateWithToolsFn,
  extractJson: ExtractJsonFn,
  maxToolCalls: number,
): Promise<{ raw: string; parsed: any; result: StepResult; traceSteps: StepResult[] }> {
  const doc = ir.context?.document;
  const constraints = ir.policies?.constraints ?? {};
  const grounding = ir.policies?.grounding;
  const schemaKeys = Object.keys(schema.properties ?? {});

  const basePrompt = ir.system
    ?? (constraints.tone?.to ? `You are a ${constraints.tone.to} agent.` : 'You are an agent.');

  const systemParts = [
    basePrompt,
    '',
    schemaPromptBlock(schema),
    '',
    'You have access to tools. Call them as needed to complete the task.',
    'When you are done, respond with the final JSON output matching the schema above.',
    'OUTPUT RULES:',
    '- Final output MUST be JSON only. No markdown. No code fences. No reasoning.',
    '- Final output must start with "{" and end with "}".',
  ];

  if (grounding?.require_citations) {
    systemParts.push(
      '',
      'GROUNDING RULES:',
      '- Every item in arrays with a citations field MUST include citations.',
      '- Each citation MUST include a quote field with EXACT verbatim text from the document.',
      '- Do not paraphrase or fabricate quotes.',
    );
  }

  // Build context prompt parts
  const contextParts = [step.prompt, '', 'DOCUMENT:', String(doc ?? '')];
  const context = ir.context ?? {};
  for (const key of Object.keys(context)) {
    if (key.endsWith('_enriched')) {
      const label = key.replace(/_enriched$/, '').toUpperCase() + '_ANALYSIS';
      const value = typeof context[key] === 'string' ? context[key] : JSON.stringify(context[key], null, 2);
      contextParts.push('', `${label}:`, value);
    }
  }

  const messages: Message[] = [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: contextParts.join('\n') },
  ];

  const traceSteps: StepResult[] = [];
  const started = Date.now();
  let totalToolCalls = 0;
  let finalRaw = '';
  let finalParsed: any = undefined;

  const log = (msg: string) => process.stderr.write(`  ${msg}\n`);
  log(`⟳ Agentic loop started (max ${maxToolCalls} tool calls)`);

  for (let turn = 0; turn < maxToolCalls + 1; turn++) {
    const turnStarted = Date.now();

    // On the last allowed turn, omit tools to force the model to produce content
    const toolsForTurn = totalToolCalls >= maxToolCalls ? [] : toolsOpenAI;
    if (toolsForTurn.length === 0 && totalToolCalls > 0) {
      log(`⟳ Turn ${turn + 1}: forcing final output (tool call limit reached)`);
      // Add an explicit instruction to produce the final answer
      messages.push({
        role: 'user',
        content: 'You have gathered enough information. STOP calling tools. Produce your final JSON output now. Output MUST be JSON only, starting with { and ending with }.',
      });
    } else {
      log(`⟳ Turn ${turn + 1}: calling model...`);
    }

    const response = await generateWithTools({
      model: ir.model.id,
      messages,
      tools: toolsForTurn,
      max_tokens: Number(ir.model.max_tokens ?? 1200),
      temperature: ir.model.temperature,
    });

    const msg = response.message;
    const elapsed = ((Date.now() - turnStarted) / 1000).toFixed(1);

    // Belt-and-suspenders: if generateWithTools returned content but no tool_calls,
    // try parsing inline tool calls directly from msg.content.
    // This handles edge cases where generateWithTools' inline parser found calls but
    // the content also contained meaningful text that should be preserved.
    if (msg.content && !msg.tool_calls) {
      const inlineCalls = parseInlineToolCalls(msg.content);
      if (inlineCalls.length > 0) {
        msg.tool_calls = inlineCalls;
        msg.content = stripInlineToolCalls(msg.content) || null;
      }
    }

    if (msg.tool_calls?.length) {
      log(`  model responded in ${elapsed}s with ${msg.tool_calls.length} tool call(s)`);
    } else {
      log(`  model responded in ${elapsed}s with content`);
    }

    // Model wants to call tools — but not if we've hit the limit
    if (msg.tool_calls && msg.tool_calls.length > 0 && totalToolCalls < maxToolCalls) {
      // Append assistant message with tool calls to history
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      const toolResults: StepResult[] = [];
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        let fnArgs: any;
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        log(`  → ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);

        let toolResult: any;
        try {
          const tcResult = await handleToolCall(fnName, fnArgs.operation ?? fnName, fnArgs, toolRegistry, toolsAllowed);
          toolResult = tcResult.output;
          toolResults.push(tcResult);
          const preview = JSON.stringify(toolResult).slice(0, 120);
          log(`  ← ${preview}${preview.length >= 120 ? '...' : ''}`);
        } catch (e: any) {
          toolResult = { error: e.message };
          log(`  ✗ ${e.message}`);
          toolResults.push({
            type: 'ToolCall',
            ok: false,
            errors: [{ message: e.message }],
            meta: { tool: fnName, input: fnArgs },
          });
        }

        // Append tool result to message history
        messages.push({
          role: 'tool',
          content: JSON.stringify(toolResult),
          tool_call_id: tc.id,
        });

        totalToolCalls++;
      }

      traceSteps.push({
        type: 'AgenticTurn',
        ms: Date.now() - turnStarted,
        ok: true,
        meta: {
          turn: turn + 1,
          model_used: ir.model.id,
          tool_calls: msg.tool_calls.map((tc: any) => ({
            name: tc.function.name,
            args: tc.function.arguments,
          })),
          results: toolResults.map(r => r.meta),
          usage: response.usage,
        },
      });

      continue;
    }

    // Model produced content — this is the final output
    finalRaw = msg.content ?? '';
    log(`⟳ Final output received (${finalRaw.length} chars, ${totalToolCalls} tool calls)`);
    if (finalRaw) log(`  ${finalRaw.slice(0, 150)}${finalRaw.length > 150 ? '...' : ''}`);
    try {
      finalParsed = extractJson(finalRaw);
    } catch {
      log(`  ✗ Failed to parse JSON from output`);
    }

    traceSteps.push({
      type: 'AgenticFinal',
      ms: Date.now() - turnStarted,
      ok: finalParsed !== undefined,
      meta: {
        turn: turn + 1,
        total_tool_calls: totalToolCalls,
        raw_preview: finalRaw.slice(0, 400),
        usage: response.usage,
      },
    });

    break;
  }

  return {
    raw: finalRaw,
    parsed: finalParsed,
    result: {
      type: 'AgenticGenerate',
      id: step.id,
      ms: Date.now() - started,
      ok: finalParsed !== undefined,
      meta: { total_turns: traceSteps.length, total_tool_calls: totalToolCalls },
    },
    traceSteps,
  };
}
