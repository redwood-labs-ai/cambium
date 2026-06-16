import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { GenerateTextFn, ExtractJsonFn, TokenUsage } from './step-handlers.js';
import { handleGenerate, handleValidate, handleRepair } from './step-handlers.js';
import { isDocumentEntry } from './documents.js';

export type EnrichmentDef = {
  field: string;   // context field to enrich (e.g., "datadog_logs")
  agent: string;   // agent class name (e.g., "LogSummarizer")
  method?: string; // method to call (default: "summarize")
};

/**
 * RED-327: resolve the input value the sub-agent should receive given
 * a context field. Plain values pass through unchanged. `base64_pdf`
 * envelopes route through the extracted-text path (the runner's
 * `extractDocuments` populates `groundingTextByKey` upstream).
 * `base64_image` envelopes have no extractable text in v1 — return a
 * skip with a clear reason rather than passing the raw envelope to a
 * sub-agent that won't know what to do with it.
 *
 * Pure helper — caller pushes the trace step.
 */
export type EnrichmentInput =
  | { kind: 'use'; value: any }
  | { kind: 'skip'; reason: string };

export function resolveEnrichmentInput(
  contextValue: any,
  field: string,
  groundingTextByKey: Record<string, string>,
): EnrichmentInput {
  // Plain string / object / list — pass through (the sub-agent JSON-
  // stringifies non-strings on the Ruby side per existing behavior).
  // A malformed envelope (right `kind` but wrong `data` type) also
  // falls through to "use" rather than silently triggering the
  // extracted-text path — the strict isDocumentEntry guard catches
  // that case the same way the documents loader does.
  if (!isDocumentEntry(contextValue)) {
    return { kind: 'use', value: contextValue };
  }

  if (contextValue.kind === 'base64_pdf') {
    const extracted = groundingTextByKey[field];
    if (typeof extracted === 'string') {
      return { kind: 'use', value: extracted };
    }
    // PDF envelope present but extractDocuments produced no text for
    // it. Either extraction failed silently or the entry was an
    // image-only PDF — skip with a clear pointer to OCR.
    return {
      kind: 'skip',
      reason:
        `base64_pdf envelope for "${field}" produced no extractable text. ` +
        `OCR upstream and pass the text as a plain string if the PDF is image-only.`,
    };
  }

  // base64_image — no text path in v1.
  return {
    kind: 'skip',
    reason:
      `Cannot enrich a base64_image envelope for "${field}" — no extractable text. ` +
      `Image enrichment via vision-model sub-agents is a future follow-up; ` +
      `for now, OCR upstream and pass the text as a plain string.`,
  };
}

export type EnrichmentResult = {
  field: string;
  ok: boolean;
  output?: any;
  traceSteps: any[];
  usage?: TokenUsage;
};

/**
 * Run a sub-agent enrichment: compile the agent's .cmb.rb, execute its
 * generate step as a mini-transaction, return the validated output.
 *
 * The enriched output replaces the raw context field before the parent generates.
 */
export async function runEnrichment(
  enrichment: EnrichmentDef,
  contextValue: any,
  parentIr: any,
  contractsMod: any,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
  // Optional override for tests: inject a custom agent-file resolver so
  // the test can supply a temp-dir path without writing to the live gens dir
  // (AUD-F1). Defaults to the real filesystem search.
  _findAgentFile: (name: string) => string | null = findAgentFile,
): Promise<EnrichmentResult> {
  const traceSteps: any[] = [];
  const method = enrichment.method ?? 'summarize';

  // Find the agent's .cmb.rb file by looking for it in the registered classes.
  // The agent must be defined in a file that's been loaded by the parent compilation.
  // For v0, we look in the same package's gens directory.
  const agentName = enrichment.agent;
  const agentFile = _findAgentFile(agentName);

  if (!agentFile) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `Agent file not found for "${agentName}". Expected: app/gens/${agentName.toLowerCase()}.cmb.rb` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  // Compile the sub-agent by spawning Ruby
  let subIr: any;
  try {
    const contextStr = typeof contextValue === 'string' ? contextValue : JSON.stringify(contextValue);
    const irJson = execSync(
      `ruby ruby/cambium/compile.rb "${agentFile}" --method ${method} --arg -`,
      { input: contextStr, encoding: 'utf8', cwd: process.cwd() },
    );
    subIr = JSON.parse(irJson);
  } catch (e: any) {
    traceSteps.push({
      type: 'EnrichCompileError',
      ok: false,
      errors: [{ message: `Failed to compile agent "${agentName}": ${e.message}` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  // Load the sub-agent's return schema. Block-form sub-agents carry the
  // schema inline (ir.returnSchema); symbol-form fall back to the injected
  // contracts module. Mirrors runner.ts:678 (DEC-001, RED-419).
  const subSchema = subIr.returnSchema ?? contractsMod[subIr.returnSchemaId];
  if (!subSchema) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `Schema not found for agent "${agentName}" (returnSchemaId="${subIr.returnSchemaId}", inline=${!!subIr.returnSchema})` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(subSchema, subSchema.$id);
  const validate = ajv.getSchema(subSchema.$id);
  if (!validate) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `AJV schema not registered: ${subSchema.$id}` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  // Execute the sub-agent's generate step
  const genStep = subIr.steps.find((s: any) => s.type === 'Generate');
  if (!genStep) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `Agent "${agentName}" has no Generate step` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  const gen = await handleGenerate(genStep, subIr, subSchema, generateText, extractJson);
  traceSteps.push({ ...gen.result, id: `enrich_${enrichment.field}_generate` });

  let raw = gen.raw;
  let parsed = gen.parsed;
  const maxRepairAttempts = subIr.policies?.max_repair_attempts ?? 2;

  // Validate + repair loop
  let ok = false;
  for (let attempt = 0; attempt < 1 + maxRepairAttempts; attempt++) {
    const vResult = handleValidate(parsed, validate,
      attempt === 0 ? 'EnrichValidate' : 'EnrichValidateAfterRepair');

    if (vResult.ok) {
      ok = true;
      if (attempt > 0) traceSteps.push(vResult);
      break;
    }

    traceSteps.push(vResult);
    if (attempt >= maxRepairAttempts) break;

    const repair = await handleRepair(raw, vResult.errors ?? [], subSchema, subIr, attempt + 1, generateText, extractJson);
    traceSteps.push({ ...repair.result, id: `enrich_${enrichment.field}_repair_${attempt + 1}` });
    raw = repair.raw;
    parsed = repair.parsed;
  }

  // Aggregate usage from sub-steps
  const totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const step of traceSteps) {
    const usage = step.meta?.usage;
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens ?? 0;
      totalUsage.completion_tokens += usage.completion_tokens ?? 0;
      totalUsage.total_tokens += usage.total_tokens ?? 0;
    }
  }

  return {
    field: enrichment.field,
    ok,
    output: ok ? parsed : undefined,
    traceSteps,
    usage: totalUsage.total_tokens > 0 ? totalUsage : undefined,
  };
}

function findAgentFile(agentName: string): string | null {
  const snakeName = agentName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');

  const candidates = [
    join('packages', 'cambium', 'app', 'gens', `${snakeName}.cmb.rb`),
    join('packages', 'cambium', 'app', 'gens', `${agentName.toLowerCase()}.cmb.rb`),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}
