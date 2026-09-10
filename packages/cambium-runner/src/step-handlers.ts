import type { ValidateFunction } from 'ajv';
import { ToolRegistry } from './tools/registry.js';
import { testOverrideHandlers } from './tools/index.js';
import { runCorrectorPipeline } from './correctors/index.js';
import type { CorrectorContext, CorrectorFn } from './correctors/types.js';
import type { CorrectorResult } from './correctors/types.js';
import { schemaPromptBlock } from './schema-describe.js';
import { parseInlineToolCalls, stripInlineToolCalls } from './inline-tool-calls.js';
import type { SecurityPolicy } from './tools/permissions.js';
import type { Budget } from './budget.js';
import { buildToolContext } from './tools/tool-context.js';
import { getGroundingDocument } from './context.js';
import { extractDocuments, type DocumentBlock } from './documents.js';

export type StepResult = {
  type: string;
  id?: string;
  ms?: number;
  ok: boolean;
  output?: any;
  errors?: any[];
  meta?: Record<string, any>;
};

// ── Output-ceiling detection (RED-174) ─────────────────────────────────
//
// Hitting `max_tokens` truncates the completion mid-JSON. Before RED-174 the
// runner only saw text that would not parse, so it reported a parse error and
// fed the fragment to the repair loop — which regenerated under the SAME
// ceiling and truncated again, burning every attempt against a wall it could
// not move, then failing as `validation`. Nothing in the trace named the
// ceiling, on any provider.
//
// Two signals, in order of authority:
//
//   1. `stopReason === 'length'` — the provider said so. Every built-in path
//      reports it (Anthropic `stop_reason`, OpenAI-compatible
//      `finish_reason`, Ollama `done_reason`); all of it used to be dropped.
//
//   2. Completion tokens at or above the applied ceiling. This is the
//      fallback for providers that report nothing — notably custom providers
//      predating the `stopReason` contract. Consulted ONLY after a parse has
//      already failed, so a false positive can change an error message but
//      can never turn a success into a failure.

export type CeilingCheck = {
  hit: boolean;
  /** How we know: the provider told us, or we inferred it from usage. */
  source: 'reported' | 'inferred';
  /** The ceiling actually applied to the call. */
  ceiling: number;
  /** False when the ceiling is the built-in 1200 default the gen never set. */
  declared: boolean;
  completionTokens?: number;
};

/** The ceiling applied to a call, and whether the gen actually asked for it. */
export function appliedCeiling(ir: any): { ceiling: number; declared: boolean } {
  const raw = ir?.model?.max_tokens;
  const declared = raw != null;
  return { ceiling: Number(declared ? raw : DEFAULT_MAX_TOKENS), declared };
}

/** Default output ceiling when a gen declares no `max_tokens`. */
export const DEFAULT_MAX_TOKENS = 1200;

/**
 * Decide whether a completion was cut off by its output ceiling.
 *
 * @param result   Provider result (`stopReason` / `usage`).
 * @param ir       The gen IR, for the applied ceiling.
 * @param parseFailed Whether JSON extraction already failed. The usage
 *                 heuristic is gated on this; the reported signal is not.
 * @param declared  Whether the ceiling in `ir` was declared by anyone. Pass it
 *                 when the ceiling arrives in a stand-in `ir` — RED-176 repair
 *                 passes `{ model: { ...repairModel, max_tokens } }`, so the
 *                 number in force may have been declared by the gen while a
 *                 smaller one was declared for repair.
 */
export function detectOutputCeiling(
  result: { stopReason?: string; usage?: { completion_tokens?: number } } | undefined,
  ir: any,
  parseFailed: boolean,
  declared?: boolean,
): CeilingCheck | null {
  const { ceiling, declared: applied } = appliedCeiling(ir);
  const isDeclared = declared ?? applied;
  const completionTokens = result?.usage?.completion_tokens;

  if (result?.stopReason === 'length') {
    return { hit: true, source: 'reported', ceiling, declared: isDeclared, completionTokens };
  }
  // Only infer once something has already gone wrong, and only when the
  // provider stayed silent — a provider that said 'stop' is believed.
  if (parseFailed && result?.stopReason === undefined &&
      typeof completionTokens === 'number' && completionTokens >= ceiling) {
    return { hit: true, source: 'inferred', ceiling, declared: isDeclared, completionTokens };
  }
  return null;
}

/** Operator-facing message. Names the ceiling AND where it came from — the
 *  fix is almost always "raise max_tokens", and a user who never declared one
 *  has no reason to know 1200 exists. `owner` names whose declaration it was,
 *  so a repair that died on its own ceiling doesn't tell the operator to raise
 *  a limit on the gen (RED-176). */
export function ceilingMessage(c: CeilingCheck, modelUsed: string, owner = 'gen'): string {
  const label = owner === 'gen' ? 'gen' : 'repair slot';
  const origin = c.declared
    ? `the ${label}'s declared \`max_tokens\``
    : `the default \`max_tokens\` (no value declared on the ${label})`;
  const how = c.source === 'reported'
    ? `${modelUsed} reported it stopped at the limit`
    : `the completion used ${c.completionTokens} tokens, at or above the limit`;
  return (
    `Output ceiling reached: ${how}. The response was cut off mid-output, ` +
    `so it is a fragment, not malformed JSON. Limit is ${c.ceiling} tokens, from ${origin}. ` +
    `Raise \`max_tokens\` on the ${label} (or narrow the \`returns\` schema) and re-run.`
  );
}

// ── Prompt context iteration (RED-382) ─────────────────────────────────
//
// Render every key from `ir.context` other than the primary doc and
// framework-internal bookkeeping keys (anything starting with `_`).
// Labeling:
//   - `<key>_enriched` → `<KEY>_ANALYSIS:` (back-compat with the enrich
//     primitive; keeps prompts already tuned to that label stable)
//   - everything else → `<KEY>:` (new: pipeline `with: { foo: bind(...) }`
//     bindings, hand-rolled IR with extra context fields)
// Non-string values are JSON-pretty-printed; the model sees structured
// data clearly instead of `[object Object]`.
//
// #182 (DEC-012): a key named by `exclude_from_prefix` is rendered into
// `excludedParts` instead of `parts`. Same section text, same label rules,
// same skip rules — the ONLY difference is which array it lands in, so the
// two can never drift. The dispatch site splices `excludedParts` onto the
// uncached tail of the user prompt, which keeps the key fully model-visible
// while stopping it from splitting the prefix's cache key.
//
// `_` keeps its exact meaning (framework-internal: hidden AND excluded) and
// is skipped before the split is even considered — that is what makes #182
// additive. `exclude_from_prefix :_foo` is a compile error, so the two
// conventions never overlap in a compiled IR.

function appendNonPrimaryContextSections(
  parts: string[],
  excludedParts: string[],
  context: Record<string, any>,
  groundingSource: string | undefined,
  exclude: ReadonlySet<string>,
): void {
  const primaryKey = groundingSource ?? 'document';
  for (const key of Object.keys(context)) {
    if (key === primaryKey) continue;
    if (key.startsWith('_')) continue; // framework-internal (_pipeline_arg etc.)
    const raw = context[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.length === 0) continue;
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const label = key.endsWith('_enriched')
      ? key.replace(/_enriched$/, '').toUpperCase() + '_ANALYSIS'
      : key.toUpperCase();
    (exclude.has(key) ? excludedParts : parts).push('', `${label}:`, value);
  }
}

// ── Generate ──────────────────────────────────────────────────────────
export type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type GenerateTextResult = { text: string; usage?: TokenUsage };

export type GenerateTextFn = (opts: {
  model: string;
  system: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  /** RED-325: effort level for models that dropped sampling params (Opus
   *  4.7+, Fable 5, Mythos 5). Sent as `output_config.effort` alongside
   *  `thinking: { type: 'adaptive' }`; `max_tokens` is unaffected. Ignored
   *  by models that still accept temperature — the provider runner guards.
   *  Absent/invalid → provider default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  jsonSchema?: any;
  /** RED-323: typed document blocks extracted from ir.context. Providers
   *  with native doc support (Anthropic) emit these as content blocks;
   *  providers without (Ollama, oMLX) fail fast at dispatch. Empty/absent
   *  = text-only generation (back-compat). */
  documents?: DocumentBlock[];
  /** RED-325 Part 3: per-model options from `model "id", disable_thinking: true`.
   *  Empty/absent = legacy behavior (oMLX path applies thinking-suppression
   *  ONLY when disable_thinking explicit-true OR auto-detected for Qwen3). */
  modelOptions?: { disable_thinking?: boolean };
  /** RED-421: ordered fallback model ids to try on transient primary failure
   *  (connection errors / 5xx / 429). Absent → no fallback (single-model
   *  behavior unchanged). The dispatcher resolves each id through the same
   *  per-run ProviderRegistry as the primary. */
  fallbacks?: string[];
  /** Long shared payload eligible for provider-side prompt caching (e.g.
   *  the grounded document + output template that's identical across a
   *  fan-out of reviewer gens). The cache-aware provider emits it as a
   *  separate cached block; non-cache-aware providers receive a single
   *  concatenated prompt the runner builds upstream. */
  cachedPrefix?: string;
}) => Promise<GenerateTextResult>;

/** Only worth splitting the prompt when the shared payload is big enough
 *  to clear the cache floor with margin. Below this size the cache marker
 *  would be a no-op and we'd just add complexity to the request body for
 *  nothing. Char-based: Anthropic's floor is 1024 tokens for Sonnet/Haiku
 *  (~4 chars/token). The provider re-checks at request-build time, but
 *  gating here also keeps the legacy single-string path for
 *  small/ungrounded gens. */
export const MIN_CACHE_PREFIX_CHARS = 4096;

/** #182: the "exclude nothing" set. Module-level and frozen-by-convention so
 *  the second assembly pass allocates nothing. */
const EMPTY_EXCLUDE_SET: ReadonlySet<string> = new Set<string>();

export type ExtractJsonFn = (text: string) => any;

// ── Shared prompt assemblers ───────────────────────────────────────────
//
// The system block and the cacheable user-prompt prefix are a pure
// function of (ir, schema, extracted docs) — no per-call instruction
// (`step.prompt`) bleeds in. handleGenerate, handleAgenticGenerate and the
// pipeline's auto-prewarm path all build their prompts through these
// helpers, so they can never drift — byte-identity is the whole
// precondition for a cache hit.
//
// #228 (DEC-001): the agentic loop used to hand-roll its own system block,
// which is exactly the drift this comment claimed was impossible. It is a
// parameter now, not a second assembler — the variants must stay visible
// side by side or the next prompt edit re-opens the gap.

/** `opts.agentic` selects the multi-turn tool-use wording. Default (absent)
 *  is byte-identical to the single-shot `handleGenerate` system block — a
 *  whitespace change here silently invalidates every warm cache entry a
 *  deployed consumer holds (C-1). */
export function buildGenSystem(ir: any, schema: any, opts?: { agentic?: boolean }): string {
  const agentic = opts?.agentic === true;
  const constraints = ir.policies?.constraints ?? {};
  // "agent" vs "analyst" only reaches the prompt when the gen declares no
  // `system` of its own, which every real gen does.
  const role = agentic ? 'agent' : 'analyst';
  const basePrompt = ir.system
    ?? (constraints.tone?.to ? `You are a ${constraints.tone.to} ${role}.` : `You are an ${role}.`);

  const grounding = ir.policies?.grounding;
  // Agentic output is the LAST turn's message, not the whole response —
  // the rules say "Final output" so an intermediate tool-calling turn
  // isn't read as a violation.
  const outputNoun = agentic ? 'Final output' : 'Output';

  const systemParts = [
    basePrompt,
    '',
    schemaPromptBlock(schema),
    '',
  ];

  if (agentic) {
    systemParts.push(
      'You have access to tools. Call them as needed to complete the task.',
      'When you are done, respond with the final JSON output matching the schema above.',
    );
  }

  systemParts.push(
    'OUTPUT RULES:',
    `- ${outputNoun} MUST be JSON only. No markdown. No code fences. No reasoning.`,
    `- ${outputNoun} must start with "{" and end with "}".`,
  );

  // Single-shot only: an agentic gen that leaves a field empty can still go
  // call a tool instead, so the escape hatch is counterproductive there.
  if (!agentic) {
    systemParts.push('- If unsure, leave fields empty but valid.');
  }

  if (grounding?.require_citations) {
    systemParts.push(
      '',
      'GROUNDING RULES:',
      '- Every item in arrays with a citations field MUST include citations.',
      '- Each citation MUST include a quote field with EXACT verbatim text from the document.',
      agentic
        ? '- Do not paraphrase or fabricate quotes.'
        : '- Do not paraphrase or fabricate quotes. Copy text exactly as it appears.',
    );
  }

  return systemParts.join('\n');
}

/** The shared (potentially-cacheable) portion of the user prompt: DOCUMENT
 *  body + non-primary context sections + (optionally) OUTPUT_JSON_TEMPLATE,
 *  plus the gates the dispatch site uses to decide whether to split it into
 *  a cached block. Only `docInput.groundingTextByKey` is consulted;
 *  `documents` travels to the provider separately.
 *
 *  Two flags, one assembler, one policy — never a second function (DEC-001).
 *  Both default to the single-shot behavior, so an existing caller (or one
 *  passing `{}`) is unaffected.
 *
 *  `opts.requireGrounding` (default `true`) is the eligibility gate. #228
 *  (DEC-002): the agentic dispatch passes `false` — every agentic gen in
 *  the tree is ungrounded, so a grounded-only gate would fix nothing for
 *  the shape #228 was filed about, and on the agentic path the prefix is
 *  re-sent on EVERY turn, which is what makes the cache write pay for
 *  itself regardless of grounding. The single-shot path keeps the grounded
 *  gate: there, a large but per-call-varying prefix would pay ~1.25x for a
 *  cache write nothing ever reads (OQ-002).
 *
 *  `opts.includeOutputTemplate` (default `true`) emits the
 *  OUTPUT_JSON_TEMPLATE tail. #228 (DEC-008): the agentic dispatch passes
 *  `false` on SCOPE grounds — its hand-rolled prompt never carried the
 *  template, and #228 is a cost bug, so it adds no prompt CONTENT.
 *  Converging the two prompts is a fine idea; it just needs to be its own
 *  reviewed change. Precisely (AUD-002): on providers that cannot mark a
 *  breakpoint the agentic prompt is byte-identical to pre-#228; on
 *  Anthropic above the cache floor the same text is LAID OUT differently
 *  — the instruction moves after the prefix and the `\n\n` separator is
 *  dropped, since the cached region extends backward from the marker.
 *  That is the layout the single-shot path has used since 0.8.1. Cache identity is unaffected either way: the
 *  template is schema-derived and stable per gen, so it changes the prefix
 *  bytes but not their stability, which is the only property a cache hit
 *  depends on. */
export function buildCacheablePrefix(
  ir: any,
  schema: any,
  docInput: { documents: DocumentBlock[]; groundingTextByKey: Record<string, string> },
  opts?: { requireGrounding?: boolean; includeOutputTemplate?: boolean },
): {
  cacheablePrefix: string;
  excludedTail: string;
  grounded: boolean;
  useCachedPrefix: boolean;
  /** DEC-017: the cached-prefix decision, made observable. DEC-018:
   *  `judged_chars`, not `chars` — it is the length the floor gate JUDGED
   *  (exclusion applied), which under DEC-016 is deliberately not the length
   *  that shipped when caching is off. The name carries that; a doc line
   *  does not travel with the JSON. `excluded_chars` is how many bytes the
   *  declaration removed from it. Lands on the `Generate` step's trace meta,
   *  which is COMPATIBILITY surface 4 — hence renaming before it ships. */
  cachePrefix: { judged_chars: number; used: boolean; excluded_chars: number };
  /** DEC-017: true when the declaration is *the reason* caching is off — the
   *  prefix cleared the floor without the exclusion and misses it with.
   *  Intent and outcome are inverted; the dispatch site warns. */
  exclusionCostCaching: boolean;
} {
  const doc = getGroundingDocument(ir, docInput.groundingTextByKey);
  const groundingSource = ir.policies?.grounding?.source;

  // #182: `exclude_from_prefix :page_id`. Filtered to strings rather than
  // trusted, because an IR can also arrive hand-built or precompiled (#195)
  // — a malformed entry must degrade to "not excluded" (the key stays in
  // the prefix, i.e. today's behavior), never throw inside prompt assembly.
  const exclude = new Set<string>(
    Array.isArray(ir.excludeFromPrefix)
      ? ir.excludeFromPrefix.filter((k: unknown): k is string => typeof k === 'string')
      : [],
  );

  /** One assembly pass, parameterized by the exclusion set. Called twice —
   *  and only ever twice — for a gen that actually declares an exclusion
   *  (DEC-016 needs the unexcluded prefix as a fallback, DEC-017 needs its
   *  length as a baseline). A gen that declares nothing calls it once and
   *  pays exactly what it paid before #182. */
  const assemble = (excludeSet: ReadonlySet<string>): { prefix: string; tail: string } => {
    const sharedParts: string[] = [
      'DOCUMENT:',
      String(doc ?? ''),
    ];
    const excludedParts: string[] = [];

    // Include additional context fields (enrich primitive + Pipeline
    // bind() injections). RED-382: every non-framework key gets a labeled
    // prompt section.
    appendNonPrimaryContextSections(
      sharedParts,
      excludedParts,
      ir.context ?? {},
      groundingSource,
      excludeSet,
    );

    // Same defaulting shape as `requireGrounding`: a caller passing `{}` —
    // or no opts at all — gets today's single-shot behavior.
    if (opts?.includeOutputTemplate !== false) {
      // Build a JSON template from schema properties.
      const jsonTemplate: Record<string, any> = {};
      for (const key of Object.keys(schema.properties ?? {})) {
        const prop = schema.properties[key];
        if (prop.type === 'string') jsonTemplate[key] = '';
        else if (prop.type === 'array') jsonTemplate[key] = [];
        else if (prop.type === 'object') jsonTemplate[key] = {};
        else jsonTemplate[key] = null;
      }
      sharedParts.push(
        '',
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
        JSON.stringify(jsonTemplate),
      );
    }

    // #182: the excluded sections, ready to splice onto `step.prompt`. Each
    // section is pushed with a leading `''` (the blank line that separates it
    // from the previous one), so drop the first separator here and let the
    // dispatch site own the join to the instruction. `''` when nothing was
    // excluded — which is every pre-#182 gen, and is what makes the dispatch
    // sites byte-identical.
    return {
      prefix: sharedParts.join('\n'),
      tail: excludedParts.length > 0 ? excludedParts.slice(1).join('\n') : '',
    };
  };

  const applied = assemble(exclude);
  // Skipped entirely when nothing is excluded, so the common path is a
  // single assembly and `excluded_chars` is exactly 0.
  const unexcluded = exclude.size > 0 ? assemble(EMPTY_EXCLUDE_SET) : applied;

  // Opt into the cached-prefix path only when (1) grounding is declared —
  // without it the "shared payload" framing is misleading — and (2) the
  // prefix is large enough to clear Anthropic's cache floor with margin.
  // Callers that re-send the prefix every turn waive (1); see the
  // `requireGrounding` note above.
  //
  // #182 (DEC-016): the gate judges the EXCLUSION-APPLIED prefix, always.
  // One decision, made once — deciding on the unexcluded prefix and then
  // applying the exclusion could flip the answer the exclusion depends on.
  const grounded = !!ir.policies?.grounding;
  const eligible = opts?.requireGrounding === false ? true : grounded;
  const useCachedPrefix = eligible && applied.prefix.length >= MIN_CACHE_PREFIX_CHARS;

  // #182 (DEC-016) — the exclusion applies ONLY when the cached-prefix path
  // is actually taken.
  //
  // DEC-012 justified the tail with "the provider orders [prefix][userText]
  // and a cache region extends backward, so the tail is outside it". That is
  // true of the CACHE-AWARE path only. `legacyPrompt` is
  // `${promptText}\n\n${cacheablePrefix}`, so on the non-cached path the tail
  // lands BEFORE the prefix — inserting the excluded sections between the
  // instruction and `DOCUMENT:`, for zero caching benefit. And that path is
  // not an edge case: `supportsPromptCacheControl` is set only by
  // `anthropicCompatible`, so oMLX and Ollama — the documented defaults —
  // always take it, as does Anthropic below the floor. With RED-421
  // fallbacks one gen could present two section orders in a single run
  // depending on which provider answered.
  //
  // So below the floor the exclusion is simply not applied: the caller gets
  // the full unexcluded prefix and an empty tail, byte-identical to pre-#182
  // — the layout every existing gen was tuned against. Two layouts in the
  // world instead of three, and the primitive is a true no-op exactly where
  // it can buy nothing. All four callers inherit this from the return value.
  const shipped = useCachedPrefix ? applied : unexcluded;
  const excludedChars = unexcluded.prefix.length - applied.prefix.length;

  return {
    cacheablePrefix: shipped.prefix,
    excludedTail: shipped.tail,
    grounded,
    useCachedPrefix,
    cachePrefix: {
      judged_chars: applied.prefix.length,
      used: useCachedPrefix,
      excluded_chars: excludedChars,
    },
    // DEC-017: the declaration is the reason caching is off only if the
    // prefix would have cleared the floor without it. `eligible` is part of
    // the test — an ungrounded single-shot gen was never going to cache, so
    // the exclusion is not what cost it anything.
    exclusionCostCaching:
      excludedChars > 0 &&
      eligible &&
      unexcluded.prefix.length >= MIN_CACHE_PREFIX_CHARS &&
      applied.prefix.length < MIN_CACHE_PREFIX_CHARS,
  };
}

export async function handleGenerate(
  step: any,
  ir: any,
  schema: any,
  generateText: GenerateTextFn,
  extractJson: ExtractJsonFn,
  /** RED-323: pre-extracted docs + extracted PDF text, supplied by the
   *  runner which extracts once per run (not per step). Optional so
   *  external callers of this handler (tests, custom pipelines) keep
   *  working without threading the extraction — in that case we run
   *  it inline here. */
  docInput?: { documents: DocumentBlock[]; groundingTextByKey: Record<string, string> },
): Promise<{ raw: string; parsed: any; result: StepResult }> {
  const { documents, groundingTextByKey } = docInput ?? await extractDocuments(ir);

  const system = buildGenSystem(ir, schema);
  const { cacheablePrefix, excludedTail, useCachedPrefix, cachePrefix, exclusionCostCaching } =
    buildCacheablePrefix(ir, schema, {
      documents,
      groundingTextByKey,
    });

  // #182 (DEC-017): excluding a large key can drop the prefix below the cache
  // floor and turn caching OFF — the exact inverse of what the author asked
  // for. The decision reaches the trace either way (`meta.cache_prefix`);
  // this line fires only for the inverted case, where the prefix cleared the
  // floor WITHOUT the exclusion and misses it with. Not a gate: the trade-off
  // is the author's to make, the defect was that it was invisible.
  if (exclusionCostCaching) {
    process.stderr.write(
      `[cambium] exclude_from_prefix turned prompt caching OFF for this gen: the prefix is ` +
        `${cachePrefix.judged_chars} chars with the exclusion applied ` +
        `(floor ${MIN_CACHE_PREFIX_CHARS}), ` +
        `${cachePrefix.judged_chars + cachePrefix.excluded_chars} without it. ` +
        `Drop the declaration or shrink the excluded keys to keep caching.\n`,
    );
  }

  // AUD-005 / AUD-R2-001: normalize ONCE, here, not at the sinks. `main`
  // built the prompt with `[step.prompt, …].join('\n')`, and Array.join
  // coerces null/undefined to ''; a template literal stringifies them, so a
  // step with no `prompt` — `generate(nil)`, or a hand-built / precompiled
  // .ir.json (#195) that omits the field — would put the literal text
  // "null" on the first line. Both dispatch branches below read
  // `promptText`: the round-1 fix touched only `legacyPrompt`, which the
  // cached branch never uses, so a grounded gen above the cache floor still
  // emitted "null" — the same gen's prompt depended on document size.
  // Fixing the two downstream sinks in runner.ts instead would be wrong:
  // they are shared with the agentic path and with library callers of
  // `makeGenerateText`, and would leave this handler free to emit `null`
  // into a field typed `prompt: string`.
  // See PLAN § C-1 exception — the ONLY inputs whose bytes move are
  // null/undefined.
  //
  // #182 (DEC-012): `exclude_from_prefix` sections ride the uncached tail.
  // The provider orders `[prefix][userText]` and the shared user-prefix cache
  // region extends BACKWARD from its marker, so anything appended here is
  // outside THAT region — no new provider mechanics. Only reachable when the
  // cached path is live: below the floor `excludedTail` is `''` by
  // construction (DEC-016).
  //
  // `\n\n` is the separator `legacyPrompt` uses. AUD-182-003: joined by
  // filtering rather than a ternary, so an absent instruction does not leave
  // the prompt starting with a blank line. Byte-identical to the ternary for
  // every other input — empty tail yields `instruction`, both present yields
  // the same `\n\n` join.
  const instruction = step.prompt ?? '';
  const promptText = [instruction, excludedTail].filter(Boolean).join('\n\n');

  // Legacy single-string prompt — byte-identical to the pre-split layout.
  // The cache-aware path reorders to prefix-first inside the provider;
  // this fallback ordering is what every non-Anthropic (or cache-disabled
  // Anthropic) call sees, so a grounded gen running against a non-cache
  // provider is unchanged.
  const legacyPrompt = `${promptText}\n\n${cacheablePrefix}`;

  const outMax = Number(ir.model.max_tokens ?? 1200);
  const started = Date.now();

  const genResult = await generateText({
    model: ir.model.id,
    system,
    prompt: useCachedPrefix ? promptText : legacyPrompt,
    max_tokens: outMax,
    temperature: ir.model.temperature,
    effort: ir.effort,
    jsonSchema: schema,
    documents,
    modelOptions: ir.model.options,
    // RED-421: pass fallbacks so the dispatcher can walk them on transient failure.
    fallbacks: ir.model.fallbacks,
    cachedPrefix: useCachedPrefix ? cacheablePrefix : undefined,
  });

  const raw = genResult.text;
  // model_used reflects the actual model that produced the result (primary or a
  // fallback); the dispatcher sets it on the result when a fallback was taken.
  const modelUsed: string = (genResult as any).modelUsed ?? ir.model.id;
  let parsed: any = undefined;
  let parseError: string | undefined;
  try {
    parsed = extractJson(raw);
  } catch (e: any) {
    parseError = e.message;
  }

  // RED-174. A reported ceiling fails even if the fragment happens to parse:
  // `extractJsonObject` slices to the last `}`, so a truncated response can
  // yield a *prefix* object that validates while silently missing content.
  // The provider saying "I cut this off" is better evidence than parseability.
  const ceiling = detectOutputCeiling(genResult, ir, parsed === undefined);

  return {
    raw,
    parsed: ceiling ? undefined : parsed,
    result: {
      type: 'Generate',
      id: step.id,
      ms: Date.now() - started,
      ok: !ceiling && parsed !== undefined,
      errors: ceiling
        ? [{ message: ceilingMessage(ceiling, modelUsed) }]
        : parseError ? [{ message: parseError }] : undefined,
      meta: {
        model_used: modelUsed,
        raw_preview: raw.slice(0, 400),
        usage: genResult.usage,
        // #182 (DEC-017/DEC-018): the cached-prefix decision, made
        // observable. `judged_chars` is the length the floor gate judged
        // (exclusion applied) — NOT necessarily what shipped, which is why
        // the name says so; `excluded_chars` is how many bytes
        // `exclude_from_prefix` removed from it, 0 for every gen that
        // declares none.
        cache_prefix: cachePrefix,
        ...(ceiling ? { output_ceiling: ceiling } : {}),
      },
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
  /** RED-176: model spec for this repair pass — `ir.repairModel` at the two
   *  structural sites, `ir.model` (the default) everywhere else. The ceiling
   *  is read off the same object, so the trace and the operator-facing error
   *  name the model that actually ran. */
  repairModel: any = ir.model,
  /** RED-175: the material the complaint is about — the gen's `{ documents,
   *  groundingTextByKey }` plus the task text, passed at the five semantic
   *  sites (`Review`, `Consensus`, `Corrector`, `Grounding`, field-values
   *  `Grounding`). Absent at the two structural sites (schema shape,
   *  consensus-pass shape), which stay on the lean prompt and produce
   *  byte-identical requests to pre-RED-175. */
  source?: { documents: DocumentBlock[]; groundingTextByKey: Record<string, string>; task?: string },
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

  const formattedErrors = formatValidationErrors(errors);

  // RED-175: five of the seven repair sites are *semantic* — the complaint is
  // about a quote or a value that lives in the source document. Hand those the
  // document, and build their prompt through the SAME assemblers handleGenerate
  // uses (`buildGenSystem` / `buildCacheablePrefix`): byte-identical system +
  // byte-identical cached prefix means the repair rides the gen's prompt-cache
  // entry instead of re-reading the document on every attempt. Re-deriving the
  // prefix here would move the cache key, which is the trap RED-381 names.
  // The two structural sites keep the lean, context-free prompt.
  //
  // #232 — the cache-riding claim above holds for a SINGLE-SHOT gen. For
  // `mode :agentic` it does not, and cannot: repair dispatches through
  // `generateText`, which sends no tools, while the agentic Generate went
  // through `generateWithTools`. Anthropic builds cache prefixes `tools` →
  // `system` → `messages`, each level on top of the last, so a tools-less call
  // differs from that Generate at the FIRST level of the hierarchy — the same
  // argument #228's DEC-005 used to skip agentic branches in `prewarmFanOut`.
  // The entry is unreachable whatever the system block says.
  //
  // Hence the deliberate choice below: the NON-agentic variant, for every gen.
  // Threading the mode in (the shape #232 proposed) buys no cache hit and
  // costs two things — it would tell a call with no tools wired up that it
  // "has access to tools", and `includeOutputTemplate: false` would strip the
  // block that the REPAIR RULES line below names by hand, leaving the rule
  // pointing at nothing. Pinned in `repair-agentic-variant.test.ts`.
  //
  // #182 (DEC-014): this is one of `buildCacheablePrefix`'s FOUR callers —
  // the other three being `handleGenerate`, `handleAgenticGenerate` and
  // `prewarmFanOut`, which discards `excludedTail` on purpose (discarding it
  // IS the fan-out collapse). Repair takes it for the same reason the two
  // dispatch sites do: without it, a gen that declares `exclude_from_prefix`
  // would have those sections in neither the prefix nor the tail on the
  // repair path — repair seeing less than Generate did is precisely the
  // failure RED-175 exists to prevent.
  //
  // It is free: the excluded sections sit outside the SHARED USER-PREFIX
  // cache region — the one keyed on `cachedPrefix`, which is the key this
  // comment protects — so appending them to an already-uncached tail cannot
  // move it. (AUD-182-004: "outside the cached region" full stop would be
  // false on the agentic path, where Anthropic's top-level automatic
  // breakpoint covers the first user message from turn 2 onward. Different
  // region, not this one.) Asserted, not assumed — see
  // exclude-from-prefix.test.ts § the repair path.
  let repairSystem: string;
  let repairPrompt: string;
  let cacheablePrefix = '';
  let useCachedPrefix = false;

  if (source) {
    // #232: non-agentic variant on purpose, agentic gens included. See above.
    repairSystem = buildGenSystem(ir, schema);
    const prefix = buildCacheablePrefix(ir, schema, {
      documents: source.documents,
      groundingTextByKey: source.groundingTextByKey,
    });
    const { excludedTail } = prefix;
    cacheablePrefix = prefix.cacheablePrefix;
    useCachedPrefix = prefix.useCachedPrefix;

    const tail = [
      'TASK (the instruction that produced ORIGINAL_OUTPUT):',
      source.task ?? '',
      // #182: `TASK` IS the instruction the dispatch sites splice the
      // excluded sections onto, so they go in the same place relative to it
      // here — right after, before the repair-specific blocks. Splatting an
      // empty array when nothing is excluded keeps a non-declaring gen's
      // repair prompt byte-identical.
      ...(excludedTail ? ['', excludedTail] : []),
      '',
      'ORIGINAL_OUTPUT (already produced; may be invalid):',
      raw,
      '',
      'VALIDATION_ERRORS:',
      formattedErrors.join('\n'),
      '',
      'REPAIR RULES:',
      '- Output MUST be JSON only. No markdown. No code fences. No reasoning.',
      '- Output must start with "{" and end with "}".',
      '- Edit ONLY the fields named in VALIDATION_ERRORS.',
      '- Fix every cited quote to text that appears VERBATIM in DOCUMENT above —',
      '  copy it exactly, including punctuation.',
      '- Never delete a citation or a grounded value; correct it instead.',
      '- Keep every key from OUTPUT_JSON_TEMPLATE. Add none.',
      '',
      'Return repaired JSON only.',
    ];
    repairPrompt = (useCachedPrefix
      ? tail
      : [cacheablePrefix, '', ...tail]
    ).join('\n');
  } else {
    repairSystem = [
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

    repairPrompt = [
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
  }

  const genCeil = appliedCeiling(ir);
  // RED-176: repair re-emits the whole document, so its ceiling is the LARGER of
  // the slot's own `max_tokens` and the gen's — a cap smaller than generate had
  // turns one recoverable schema failure into a hard `output_ceiling` failure,
  // which is the trap RED-174's notes warn about. No repair slot → gen's ceiling.
  const outMax = repairModel === ir.model
    ? genCeil.ceiling
    : Math.max(genCeil.ceiling, Number(repairModel.max_tokens ?? DEFAULT_MAX_TOKENS));
  // Attribute the number to whoever set it — with the floor in force the limit
  // binding repair is often the gen's, even though a repair model ran.
  const ceilingOwner = outMax > genCeil.ceiling ? 'repair slot' : 'gen';
  const ceilingDeclared = ceilingOwner === 'repair slot'
    ? !!repairModel?.max_tokens
    : genCeil.declared;
  const started = Date.now();

  const genResult = await generateText({
    model: repairModel.id,
    system: repairSystem,
    prompt: repairPrompt,
    max_tokens: outMax,
    temperature: repairModel.temperature,
    // RED-176: `effort` and the fallback chain were chosen for the gen's
    // model. Forwarding `effort` to a non-Anthropic repair model is the
    // silent no-op the issue calls out (only anthropicCompatible reads it),
    // and a frontier fallback would send a janitorial pass to the expensive
    // tier. No repair slot → unchanged bytes.
    ...(repairModel === ir.model
      ? { effort: ir.effort, fallbacks: ir.model.fallbacks }
      : {}),
    jsonSchema: schema,
    modelOptions: repairModel.options,
    // RED-175: only the semantic sites carry the source. Structural requests
    // stay byte-identical (no `documents`, no `cachedPrefix` keys at all).
    ...(source
      ? {
          documents: source.documents,
          ...(useCachedPrefix ? { cachedPrefix: cacheablePrefix } : {}),
        }
      : {}),
  });

  const newRaw = genResult.text;
  const repairModelUsed: string = (genResult as any).modelUsed ?? repairModel.id;
  let parsed: any = undefined;
  try {
    parsed = extractJson(newRaw);
  } catch {
    // will be caught by validation
  }

  // RED-174 + RED-176: the ceiling is the one applied to the model running this
  // pass — the gen's when there is no repair slot, else the larger of the gen's
  // and the slot's. A repair that hits its ceiling hits it again on every
  // remaining attempt, so mark it and let the caller stop paying for it.
  const ceiling = detectOutputCeiling(
    genResult,
    { model: { ...repairModel, max_tokens: outMax } },
    parsed === undefined,
    ceilingDeclared,
  );

  return {
    raw: newRaw,
    parsed: ceiling ? undefined : parsed,
    result: {
      type: 'Repair',
      ms: Date.now() - started,
      ok: !ceiling && parsed !== undefined,
      errors: ceiling
        ? [{ message: ceilingMessage(ceiling, repairModelUsed, ceilingOwner) }]
        : undefined,
      meta: {
        attempt,
        model_used: repairModelUsed,
        max_tokens: outMax,
        // RED-175: makes "what did repair actually see" legible without diffing
        // the prompt by hand. Two numbers, because a semantic pass can carry
        // its source as either — and `source_chars` alone cannot tell them
        // apart. `getGroundingDocument` returns '' for a native document
        // envelope (`coerceDocumentValue` refuses base64_pdf / base64_image),
        // so an Anthropic-native PDF repair reported `source_chars: 0` — the
        // exact value that means "context-free structural pass" — while
        // actually carrying a 40-page filing. The structural discriminator is
        // both being 0; `source_doc_bytes` is the cost signal on the native
        // path, `source_chars` on the extracted-text path.
        source_chars: source ? getGroundingDocument(ir, source.groundingTextByKey).length : 0,
        source_docs: source ? source.documents.length : 0,
        source_doc_bytes: source
          ? source.documents.reduce((n, d) => n + (d.decoded_bytes ?? 0), 0)
          : 0,
        raw_preview: newRaw.slice(0, 400),
        usage: genResult.usage,
        ...(ceiling ? { output_ceiling: ceiling } : {}),
      },
    },
  };
}

// ── Correct ───────────────────────────────────────────────────────────
// RED-299: `correctors` map is passed in explicitly. Prior to RED-299
// `runCorrectorPipeline` read a module-global; the runner now builds
// a per-call map (built-ins ∪ legacy registerAppCorrectors ∪
// opts.correctors ∪ engine-sibling) and threads it through every call
// site. Any new caller of handleCorrect must pass the correctors map.
export function handleCorrect(
  data: any,
  correctorNames: string[],
  context: CorrectorContext,
  correctors: Record<string, CorrectorFn>,
): StepResult {
  const started = Date.now();
  const { data: corrected, results } = runCorrectorPipeline(correctorNames, data, context, correctors);
  const anyCorrected = results.some(r => r.corrected);
  const allIssues = results.flatMap(r => r.issues);

  // RED-323 fix: merge each corrector's `meta` into the StepResult's
  // `meta` so downstream code can read corrector-specific results
  // (e.g. the citations corrector exposes `citationResult` which the
  // GroundingCheck step needs to determine if citations actually
  // verified). Prior behavior dropped this meta, leaving the GroundingCheck's
  // `ok` field defaulting to true regardless of actual citation matches —
  // an acknowledged dead-code path called out in runner.ts. Fixed here
  // as part of making grounded_in + PDF actually verify.
  const mergedMeta: Record<string, any> = {
    correctors: correctorNames,
    corrected: anyCorrected,
    issues: allIssues,
  };
  for (const r of results) {
    if (r.meta && typeof r.meta === 'object') {
      Object.assign(mergedMeta, r.meta);
    }
  }

  return {
    type: 'Correct',
    ms: Date.now() - started,
    ok: true,
    output: corrected,
    meta: mergedMeta,
  };
}

// ── ToolCall ──────────────────────────────────────────────────────────
/**
 * Optional per-run environment threaded into handleToolCall. When provided,
 * each fields enables an extra guard at the dispatch site:
 *
 *   - policy   → builds a ToolContext with a policy-bound fetch (SSRF guard)
 *                and emits tool.permission.granted/denied trace events.
 *   - budget   → runs checkBeforeCall and emits tool.budget.exceeded; refuses
 *                dispatch if the call would violate any per-tool or per-run limit.
 *   - traceEvents → array to append structured events into (runner's trace.steps).
 *
 * All fields are optional; unit tests and scripts that call handleToolCall
 * without an env still work exactly as before.
 */
export type ToolCallEnv = {
  policy?: SecurityPolicy;
  budget?: Budget;
  traceEvents?: any[];
};

export async function handleToolCall(
  toolName: string,
  operation: string,
  input: any,
  registry: ToolRegistry,
  allowlist: string[],
  env: ToolCallEnv = {},
): Promise<StepResult> {
  const started = Date.now();

  registry.assertAllowed(toolName, allowlist);

  const def = registry.get(toolName);
  if (!def) throw new Error(`Tool "${toolName}" not found in registry. Available: ${registry.list().join(', ')}`);

  const events = env.traceEvents;

  // Budget pre-call gate. Must run BEFORE any other gate so budget
  // violations always surface first in the trace — invariant from
  // RED-137's ToolCallEnv contract.
  if (env.budget) {
    const violation = env.budget.checkBeforeCall(toolName);
    if (violation) {
      if (events) events.push({
        type: 'tool.budget.exceeded',
        tool: toolName,
        metric: violation.limit,
        current: violation.used,
        increment: 1,
        limit: violation.max,
      });
      const err: any = new Error(violation.message);
      err.budgetViolation = violation;
      throw err;
    }
  }

  // Post-RED-221: all tools — framework-builtin and app-supplied —
  // are auto-discovered plugin tools, so the registry is authoritative.
  // testOverrideHandlers is a narrow escape hatch for tests that need
  // to shim a handler without writing a fixture file; dispatch uses it
  // only as a fallback when the registry has no handler.
  const impl = registry.getHandler(toolName) ?? testOverrideHandlers[toolName];
  if (!impl) {
    throw new Error(
      `No implementation found for tool "${toolName}". Declare a handler in ` +
      `app/tools/${toolName}.tool.ts (paired with the .tool.json).`,
    );
  }

  // AUD-007: validate the model-supplied input against the tool's declared
  // inputSchema before dispatch. The validator is compiled at registration
  // time (ToolRegistry.loadFromDir) so this is a fast synchronous call.
  // Rejects malformed input before it reaches the handler — both for safety
  // and to surface schema mismatches in the trace rather than as cryptic
  // handler errors. testOverrideHandlers don't have registered validators
  // (they bypass the .tool.json path), so absent validator = skip validation.
  const inputValidator = registry.getInputValidator(toolName);
  if (inputValidator) {
    const valid = inputValidator(input);
    if (!valid) {
      // `!valid` alone is load-bearing — never gate the throw on
      // `errors` being populated, or an AJV mode that returns false
      // with empty errors would silently pass invalid input (AUD-F3).
      const errors = inputValidator.errors ?? [];
      throw new Error(
        `Tool "${toolName}" input schema validation failed: ` +
        (errors.length
          ? errors.map((e: any) =>
              `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
            ).join('; ')
          : 'input does not match the tool inputSchema'),
      );
    }
  }

  // Build the ToolContext (policy-bound fetch for network tools +
  // exec policy for execute_code-class tools that dispatch through
  // the substrate registry, RED-248 + emitStep for tools that push
  // structured steps onto the runner's trace.steps — currently
  // execute_code emitting Exec* step types per RED-249).
  const ctx = buildToolContext({
    toolName,
    policy: env.policy?.network,
    execPolicy: env.policy?.exec,
    filesystemPolicy: env.policy?.filesystem,
    emitStep: env.traceEvents ? (step) => env.traceEvents!.push(step) : undefined,
  });

  let result: any;
  try {
    result = await Promise.resolve(impl(input, ctx));
  } catch (e: any) {
    // If the network guard denied the call, emit a structured trace event.
    if (e?.guardDecision && events) {
      const d = e.guardDecision;
      events.push({
        type: 'tool.permission.denied',
        tool: toolName,
        host: d.host,
        reason: d.reason,
        rule: d.rule,
        resolved_ips: d.resolved_ips,
      });
    }
    throw e;
  }

  // Record the call against the per-tool / per-run budget.
  env.budget?.addToolCall(toolName);

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
  /** RED-325: effort level for models that dropped sampling params (Opus
   *  4.7+, Fable 5, Mythos 5). Same semantics as GenerateTextFn.effort;
   *  threaded through the IR by the runner. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** RED-323: typed document blocks extracted from ir.context, same as
   *  the generateText path. Anthropic emits them as user-message content
   *  blocks on the first turn (subsequent turns reuse them via cache).
   *  Ollama/oMLX fail fast when documents are present. */
  documents?: DocumentBlock[];
  /** RED-325 Part 3: per-model options from `model "id", disable_thinking: true`. */
  modelOptions?: { disable_thinking?: boolean };
  /** RED-421: ordered fallback model ids. See GenerateTextFn.fallbacks. */
  fallbacks?: string[];
  /** #205 (DEC-004): the step's output schema, for the `--mock` path only —
   *  under mock the agentic loop's single turn of text IS the final output,
   *  so it needs the same schema-derived mock as generateText. NEVER
   *  forwarded to a real provider (the dispatch site below doesn't pass it
   *  through to `provider.generateWithTools`). */
  jsonSchema?: any;
  /** #228: the shared, cacheable head of the FIRST user message (document +
   *  context sections + output template). Same semantics as
   *  `GenerateTextFn.cachedPrefix`: providers that can't emit a user-prompt
   *  cache breakpoint never see it — the runner folds it back into the
   *  first user message upstream, using the same
   *  `supportsPromptCacheControl` gate generateText uses. */
  cachedPrefix?: string;
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
  env: ToolCallEnv = {},
  /** RED-323: pre-extracted docs + PDF text (runner-owned). Fallback
   *  to inline extraction for external callers. */
  docInput?: { documents: DocumentBlock[]; groundingTextByKey: Record<string, string> },
): Promise<{ raw: string; parsed: any; result: StepResult; traceSteps: StepResult[] }> {
  const { documents, groundingTextByKey } = docInput ?? await extractDocuments(ir);

  // #228 (DEC-001/DEC-002): both prompt halves come from the shared
  // assemblers now. The DOCUMENT body, the RED-382 context sections and the
  // output template are the bytes that repeat on every turn of the loop, so
  // they are the cacheable prefix; `step.prompt` is the uncached tail.
  const system = buildGenSystem(ir, schema, { agentic: true });
  const { cacheablePrefix, excludedTail, useCachedPrefix } = buildCacheablePrefix(
    ir,
    schema,
    { documents, groundingTextByKey },
    {
      // Agentic re-sends the prefix every turn — size alone justifies the
      // cache write, and every agentic gen in the tree is ungrounded.
      requireGrounding: false,
      // DEC-008: the hand-rolled agentic prompt never carried the output
      // template. #228 is a cost bug and adds no prompt CONTENT — on
      // Anthropic above the cache floor the same text is laid out
      // differently (AUD-002); see the docblock on buildCacheablePrefix.
      includeOutputTemplate: false,
    },
  );

  // AUD-005 / AUD-R2-001: normalize once, same as handleGenerate — both
  // branches below read `promptText`. #182: and the excluded sections are
  // spliced on the same way (AUD-182-003 filter-join included), for the same
  // reason. See the notes there.
  const instruction = step.prompt ?? '';
  const promptText = [instruction, excludedTail].filter(Boolean).join('\n\n');

  // Legacy single-string layout, byte-for-byte what the runner folds back
  // for providers that can't mark a breakpoint. Used directly when the
  // prefix is under the cache floor.
  const legacyPrompt = `${promptText}\n\n${cacheablePrefix}`;

  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: useCachedPrefix ? promptText : legacyPrompt },
  ];

  const traceSteps: StepResult[] = [];
  const started = Date.now();
  // RED-184: memory of tool calls already made this run, keyed by
  // exact-duplicate signature (fnName + args). See the dispatch site below.
  const seenToolCalls = new Map<string, { tool: string; result: any }>();
  let totalToolCalls = 0;
  let finalRaw = '';
  let finalParsed: any = undefined;
  // RED-137: any budget violation during the loop flips this to true, which
  // short-circuits the next turn to a final-output-only call. Avoids the
  // denial-loop pathology where the model retries the same tool call
  // dozens of times against a per-tool cap that's never going to change.
  let budgetExhausted = false;

  const log = (msg: string) => process.stderr.write(`  ${msg}\n`);
  log(`⟳ Agentic loop started (max ${maxToolCalls} tool calls)`);

  for (let turn = 0; turn < maxToolCalls + 1; turn++) {
    const turnStarted = Date.now();

    // On the last allowed turn (or after a budget violation), omit tools to
    // force the model to produce content from what it already has.
    const forceFinal = totalToolCalls >= maxToolCalls || budgetExhausted;
    const toolsForTurn = forceFinal ? [] : toolsOpenAI;
    if (forceFinal && totalToolCalls > 0) {
      const reason = budgetExhausted ? 'budget exhausted' : 'tool call limit reached';
      log(`⟳ Turn ${turn + 1}: forcing final output (${reason})`);
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
      effort: ir.effort,
      documents,
      modelOptions: ir.model.options,
      // RED-421: fallbacks for agentic turns (each turn walks fresh).
      fallbacks: ir.model.fallbacks,
      // #205 (DEC-004): mock-only — see the type comment on GenerateWithToolsFn.
      jsonSchema: schema,
      // #228: identical to the generateText line — the runner folds it back
      // into the first user message for providers that can't mark it.
      cachedPrefix: useCachedPrefix ? cacheablePrefix : undefined,
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

        // RED-184: exact-duplicate guard. The loop had no memory of prior
        // calls, so a model that got an unsatisfying result could re-issue the
        // same call verbatim forever — observed burning 39 turns and 87k
        // transcript tokens (then a hard 400 from the provider's context
        // limit) re-running one web_search. Skip the re-dispatch, hand back a
        // synthetic turn that says so, but still count the call: this is a
        // faster trigger for the max_tool_calls backstop, not a replacement —
        // an unlimited free retry would loop forever without tripping forceFinal.
        // ASSUMPTION (reads the tool's output as inert data): the reply hands
        // back what the FIRST call returned, so it must not claim freshness —
        // web_search/execute_code/read_file may answer differently now. Say
        // "the result you got then", never "the result is unchanged": a lie in
        // the transcript gets quoted straight into the final answer.
        // Exact match only. Stale-read ceiling: read_file after a write returns
        // the pre-write bytes. Fuzzy match for reworded near-duplicates is the
        // follow-up if this undershoots.
        // Only SUCCESSFUL dispatches are memoized (see the `catch` below). A
        // throw is a fact about that attempt, not about the call: caching it
        // would turn the guard into a permanent block on the retry-after-a-
        // transient-failure path every agentic loop depends on, and would file
        // the replay in the trace as `ok: true` when the real call was `ok:
        // false`. A tool that fails deterministically still re-dispatches, but
        // it is bounded by maxToolCalls exactly as it was before RED-184.
        const signature = `${fnName}\u0000${JSON.stringify(fnArgs)}`;
        const prior = seenToolCalls.get(signature);

        let toolResult: any;
        // `!== undefined`, not truthiness: today the value is always a
        // {tool, result} wrapper, but a truthy test breaks the moment anyone
        // stores a bare falsy result (0, "", null) and the loop starts
        // re-dispatching the very call this guard exists to kill.
        if (prior !== undefined) {
          env.budget?.addToolCall(fnName);
          const echo = JSON.stringify(prior.result) ?? 'null';
          const fits = echo.length <= 2000;
          toolResult = {
            duplicate: true,
            note: `You already called ${prior.tool} with these exact arguments earlier in this run — what follows is the result you got THEN, not a fresh call. Do NOT repeat it: try a different query/tool, or produce your final JSON output now.`,
            previous_result: fits ? echo : `${echo.slice(0, 2000)}...(truncated)`,
          };
          toolResults.push({
            type: 'ToolCall',
            ok: true,
            output: toolResult,
            meta: { tool: fnName, input: fnArgs, duplicate: true },
          });
          log(`  ↻ ${fnName} duplicate call skipped (already made this run)`);
        } else {
          try {
            const tcResult = await handleToolCall(fnName, fnArgs.operation ?? fnName, fnArgs, toolRegistry, toolsAllowed, env);
            toolResult = tcResult.output;
            toolResults.push(tcResult);
            const preview = JSON.stringify(toolResult).slice(0, 120);
            log(`  ← ${preview}${preview.length >= 120 ? '...' : ''}`);
            // Inside the try, after the push: only a call that actually
            // returned is remembered. See the note above the signature.
            seenToolCalls.set(signature, { tool: fnName, result: toolResult });
          } catch (e: any) {
            toolResult = { error: e.message };
            log(`  ✗ ${e.message}`);
            toolResults.push({
              type: 'ToolCall',
              ok: false,
              errors: [{ message: e.message }],
              meta: { tool: fnName, input: fnArgs },
            });
            // Budget violations are terminal for the loop — the limit won't
            // change no matter how many times the model retries. They are also
            // the one failure that must not be charged: the gate refused the
            // call before it ran. Every other failure dispatched and is
            // charged, so a deterministically failing tool cannot be retried
            // for free.
            if (e.budgetViolation) budgetExhausted = true;
            else env.budget?.addToolCall(fnName);
          }
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
          // RED-421: reflect the actual provider used (primary or fallback).
          model_used: (response as any).modelUsed ?? ir.model.id,
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

    // RED-174: this branch used to swallow the failure in a bare catch and
    // record `ok: false` with no reason at all — even less diagnosable than
    // the non-agentic path, which at least kept the parse error.
    const finalCeiling = detectOutputCeiling(response, ir, finalParsed === undefined);
    if (finalCeiling) {
      finalParsed = undefined;
      log(`  ✗ Output ceiling reached (${finalCeiling.ceiling} tokens, ${finalCeiling.source})`);
    }

    traceSteps.push({
      type: 'AgenticFinal',
      ms: Date.now() - turnStarted,
      ok: !finalCeiling && finalParsed !== undefined,
      errors: finalCeiling
        ? [{ message: ceilingMessage(finalCeiling, ir.model.id) }]
        : undefined,
      meta: {
        turn: turn + 1,
        total_tool_calls: totalToolCalls,
        raw_preview: finalRaw.slice(0, 400),
        usage: response.usage,
        ...(finalCeiling ? { output_ceiling: finalCeiling } : {}),
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
