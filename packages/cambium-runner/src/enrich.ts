import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { GenerateTextFn, ExtractJsonFn, TokenUsage } from './step-handlers.js';
import { handleGenerate, handleValidate, handleRepair } from './step-handlers.js';

export type EnrichmentDef = {
  field: string;   // context field to enrich (e.g., "datadog_logs")
  agent: string;   // agent class name (e.g., "LogSummarizer")
  method?: string; // method to call (default: "summarize")
};

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
): Promise<EnrichmentResult> {
  const traceSteps: any[] = [];
  const method = enrichment.method ?? 'summarize';

  // Find the agent's .cmb.rb file by looking for it in the registered classes.
  // The agent must be defined in a file that's been loaded by the parent compilation.
  // For v0, we look in the same package's gens directory.
  const agentName = enrichment.agent;
  const agentFile = findAgentFile(agentName);

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

  // Load the sub-agent's return schema
  const subSchema = contractsMod[subIr.returnSchemaId];
  if (!subSchema) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `Schema "${subIr.returnSchemaId}" not found in contracts for agent "${agentName}"` }],
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
