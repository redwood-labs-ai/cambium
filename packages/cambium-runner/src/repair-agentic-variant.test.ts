import { describe, it, expect } from 'vitest';
import { handleRepair, MIN_CACHE_PREFIX_CHARS } from './step-handlers.js';

// #232 — semantic repair deliberately builds through the NON-agentic variant of
// the shared assemblers, for every gen, including `mode :agentic` ones.
//
// The ticket proposed threading the gen's mode in
// (`buildGenSystem(ir, schema, { agentic: ir.mode === 'agentic' })` plus
// `includeOutputTemplate: ir.mode !== 'agentic'`) so that "the SAME assemblers"
// would mean the same *variant*. That fix was rejected; these are the pins that
// keep it from being re-applied by someone reading the ticket and not the
// decision. Each `it` below is one of the three reasons.
//
// Reason 1 is the one that decides it: repair dispatches through `generateText`,
// which sends NO tools, and Anthropic builds cache prefixes `tools` → `system`
// → `messages`, each level on top of the last. A tools-less call diverges from
// an agentic Generate at the FIRST level of the hierarchy, so it cannot read
// that entry no matter what the system block and prefix say. This is the same
// argument #228's DEC-005 used to skip agentic branches in `prewarmFanOut`.

const LONG_DOC = `ACME FY2025 FILING\n\nTotal revenue was $12,345 across all segments. ${'Section filler: the vendor reports quarterly figures net of returns. '.repeat(70)}\nClosing note: audited figures only.`;

function baseIR(mode: 'single' | 'agentic'): any {
  return {
    version: '0.2',
    entry: { class: 'Researcher', method: 'research', source: 'researcher.cmb.rb' },
    model: { id: 'omlx:test', temperature: 0.1, max_tokens: 1200 },
    system: 'You research vendor financials.',
    mode,
    policies: {
      tools_allowed: mode === 'agentic' ? ['web_search'] : [],
      correctors: [],
      constraints: {},
      grounding: { source: 'document', require_citations: true },
      security: {},
    },
    returnSchemaId: 'Extract',
    context: { document: LONG_DOC },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{
      id: 'g1', type: 'Generate', prompt: 'Extract the vendor and its FY2025 total.',
      with: { context: 'doc' }, returns: 'Extract',
    }],
  };
}

const schema: any = {
  $id: 'Extract',
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string' }, citations: { type: 'array' } },
};
const jsonOf = (o: unknown) => JSON.stringify(o, null, 2);
const extractJson = (s: string) => JSON.parse(s);

function recorder(text: string) {
  const calls: any[] = [];
  const fn = async (opts: any) => {
    calls.push(opts);
    return { text, usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }, stopReason: 'stop' };
  };
  return { calls, fn };
}

/** A semantic (grounding) repair of `ir`, returning the recorded dispatch. */
async function semanticRepair(ir: any) {
  const { calls, fn } = recorder(jsonOf({ summary: 'Acme', citations: [{ quote: 'Total revenue was $12,345' }] }));
  await handleRepair(
    jsonOf({ summary: 'Acme', citations: [{ quote: 'Total revenue was $99,999' }] }),
    [{ instancePath: '/citations/0/quote', message: 'Grounding: quote not found in source' }],
    schema, ir, 1, fn, extractJson, ir.model,
    { documents: [], groundingTextByKey: { document: LONG_DOC }, task: 'Extract the total.' },
  );
  return calls[0];
}

describe('#232 — semantic repair uses the non-agentic assembler variant, on purpose', () => {
  it('reason 1: the repair dispatch carries no tools, so no agentic cache entry is reachable', async () => {
    const call = await semanticRepair(baseIR('agentic'));

    // `generateText`, not `generateWithTools`. Nothing on the recorded dispatch
    // describes a tool, so `tools` is the first level of Anthropic's prefix
    // hierarchy and it already differs from what the agentic Generate sent.
    expect(call.tools).toBeUndefined();

    // The prefix IS still cached — repair attempt 2 can read attempt 1's entry.
    // What is unreachable is the *Generate* entry, not caching as such.
    expect(LONG_DOC.length).toBeGreaterThan(MIN_CACHE_PREFIX_CHARS);
    expect(typeof call.cachedPrefix).toBe('string');
    expect(call.cachedPrefix.length).toBeGreaterThanOrEqual(MIN_CACHE_PREFIX_CHARS);
  });

  it('reason 2: the repair system block never tells a tools-less call it has tools', async () => {
    const call = await semanticRepair(baseIR('agentic'));

    // `buildGenSystem(ir, schema, { agentic: true })` would add these two lines.
    // On a call with no tools wired up they are false, and an emitted tool call
    // would have nothing to dispatch it.
    expect(call.system).not.toContain('You have access to tools');
    expect(call.system).not.toContain('Final output');

    // And the escape hatch the agentic variant suppresses belongs here: it is
    // suppressed there only because an agentic gen can call a tool instead.
    expect(call.system).toContain('If unsure, leave fields empty but valid');
  });

  it('reason 3: REPAIR RULES names OUTPUT_JSON_TEMPLATE, so the block must be present', async () => {
    const call = await semanticRepair(baseIR('agentic'));
    const seen = `${call.cachedPrefix ?? ''}\n${call.prompt}`;

    // `includeOutputTemplate: ir.mode !== 'agentic'` would strip the block while
    // leaving the rule that points at it — a dangling reference in the prompt.
    expect(seen).toContain('Keep every key from OUTPUT_JSON_TEMPLATE');
    expect(seen).toContain('OUTPUT_JSON_TEMPLATE (fill this');
  });

  it('mode does not fork the repair prompt: agentic and single agree byte-for-byte', async () => {
    const agentic = await semanticRepair(baseIR('agentic'));
    const single = await semanticRepair(baseIR('single'));

    expect(agentic.system).toBe(single.system);
    expect(agentic.cachedPrefix).toBe(single.cachedPrefix);
    expect(agentic.prompt).toBe(single.prompt);
  });
});
