import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { GenerateTextFn, ExtractJsonFn, TokenUsage } from './step-handlers.js';
import { handleGenerate, handleValidate, handleRepair, NO_JSON_REASK_DIRECTIVE } from './step-handlers.js';
import { isDocumentEntry } from './documents.js';
import { resolveCompileRb } from './compile-rb.js';

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
  // #219 DEV-004/DEV-005: app-package root (RED-286: `<root>/packages/cambium`
  // for a [workspace] Genfile, `<root>` for a [package] Genfile) — the SAME
  // `appPkgRoot` `runGen` already resolves via `resolveAppRoot` and uses for
  // tool/action/provider/log-sink discovery (CLAUDE.md's "App-root resolution
  // is single-sourced" invariant: never re-resolve from cwd independently
  // here). Threaded down from `runGen`'s call site.
  //
  // DELIBERATELY NO DEFAULT. `process.cwd()` plus a hardcoded `packages/cambium`
  // prefix is exactly the pair of bugs #219 exists to remove (the cwd
  // dependency AND the [workspace]-only layout assumption) — a default here
  // would silently reintroduce both the moment a future call site omits this
  // argument, with no compile error to catch it. Required on purpose: every
  // caller must state where its app root actually is. Positioned before the
  // optional test-override parameters below so it can be required without a
  // "required parameter after optional" TS error.
  appPkgRoot: string,
  // Optional override for tests: inject a custom agent-file resolver so
  // the test can supply a temp-dir path without writing to the live gens dir
  // (AUD-F1). When omitted, resolves via findAgentFile(name, appPkgRoot) below.
  _findAgentFile?: (name: string) => string | null,
  // #219: explicit `ruby/cambium/compile.rb` path, threaded from
  // `RunGenFromIrOptions.compileRb` via `runGen`. See `compile-rb.ts#resolveCompileRb`
  // for the fallback chain used when this is omitted.
  compileRb?: string,
): Promise<EnrichmentResult> {
  const traceSteps: any[] = [];
  const method = enrichment.method ?? 'summarize';

  // Find the agent's .cmb.rb file under <appPkgRoot>/app/gens/ — layout-aware
  // (RED-286): appPkgRoot is already the right root for both [workspace] and
  // [package] shapes, resolved upstream from ir.entry.source, never cwd.
  const agentName = enrichment.agent;
  const resolveAgentFile = _findAgentFile ?? ((name: string) => findAgentFile(name, appPkgRoot));
  const agentFile = resolveAgentFile(agentName);

  if (!agentFile) {
    traceSteps.push({
      type: 'EnrichError',
      ok: false,
      errors: [{ message: `Agent file not found for "${agentName}". Expected: app/gens/${agentName.toLowerCase()}.cmb.rb` }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  // #219: resolve compile.rb before spawning — a caller-passed cwd doesn't
  // enter into it any more (#242: shared chain, see compile-rb.ts).
  const resolvedCompileRb = resolveCompileRb(compileRb);
  if (!resolvedCompileRb) {
    traceSteps.push({
      type: 'EnrichCompileError',
      ok: false,
      errors: [{
        message:
          'Could not locate ruby/cambium/compile.rb to compile agent ' +
          `"${agentName}". Pass compileRb explicitly (RunGenFromIrOptions.compileRb), ` +
          'set CAMBIUM_COMPILE_RB, or run from the cambium monorepo root.',
      }],
    });
    return { field: enrichment.field, ok: false, traceSteps };
  }

  // Compile the sub-agent by spawning Ruby. #219: argv array via spawnSync,
  // never a shell string — the agent file path is not shell-escaped.
  let subIr: any;
  try {
    const contextStr = typeof contextValue === 'string' ? contextValue : JSON.stringify(contextValue);
    const spawned = spawnSync(
      'ruby',
      [resolvedCompileRb, agentFile, '--method', method, '--arg', '-'],
      { input: contextStr, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    if (spawned.error) throw spawned.error;
    if (spawned.status !== 0) {
      throw new Error(
        `ruby compile.rb exited with status ${spawned.status ?? 'null'}: ${spawned.stderr || '(no stderr)'}`,
      );
    }
    subIr = JSON.parse(spawned.stdout);
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

    // #273: same "no output ≠ wrong output" rule as the main loop — a
    // sub-agent that answered in prose has no candidate, and structural
    // repair would invent one from the schema alone. Re-ask once, then
    // fail the enrichment honestly.
    if (vResult.errors?.some((e: any) => e.message === 'No data to validate')) {
      if (attempt < maxRepairAttempts) {
        const reaskStarted = Date.now();
        const reask = await handleGenerate(genStep, subIr, subSchema, generateText, extractJson, undefined, NO_JSON_REASK_DIRECTIVE);
        traceSteps.push({ ...reask.result, type: 'ReaskForJson', id: `enrich_${enrichment.field}_reask`, ms: Date.now() - reaskStarted });
        raw = reask.raw;
        parsed = reask.parsed;
        continue;
      }
      traceSteps.push({
        type: 'ReaskForJson',
        ok: false,
        id: `enrich_${enrichment.field}_reask`,
        meta: { reason: 'no_json', outcome: 'reask_failed' },
      });
      ok = false;
      break;
    }

    if (attempt >= maxRepairAttempts) break;

    // RED-176: the sub-agent's repair pass is structural (its own schema), and
    // `subIr` is a compiled gen IR — so the workspace repair slot rides along
    // on it rather than on the parent gen's IR.
    const repair = await handleRepair(
      raw, vResult.errors ?? [], subSchema, subIr, attempt + 1, generateText, extractJson, subIr.repairModel,
    );
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

/**
 * #219 DEV-004: locate the enrichment sub-agent's `.cmb.rb` file under
 * `<appPkgRoot>/app/gens/`. `appPkgRoot` is layout-aware (RED-286) —
 * `<root>/packages/cambium` for a [workspace] Genfile, `<root>` for a
 * [package] Genfile — so this resolves correctly under both project shapes
 * without special-casing either here. Never re-resolves from
 * `process.cwd()` itself; the caller (`runEnrichment`) is responsible for
 * passing the already-resolved root.
 */
function findAgentFile(agentName: string, appPkgRoot: string): string | null {
  const snakeName = agentName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');

  const candidates = [
    join(appPkgRoot, 'app', 'gens', `${snakeName}.cmb.rb`),
    join(appPkgRoot, 'app', 'gens', `${agentName.toLowerCase()}.cmb.rb`),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}
