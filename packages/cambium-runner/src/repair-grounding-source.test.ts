import { describe, it, expect, afterEach } from 'vitest';
import {
  handleRepair,
  handleGenerate,
  buildGenSystem,
  buildCacheablePrefix,
  MIN_CACHE_PREFIX_CHARS,
} from './step-handlers.js';
import { runGen } from './runner.js';

// RED-175: repair used to be handed the complaint and not the material the
// complaint was about — every checker got the document, the fixer never did.
// These pins are the two halves of the fix's contract: semantic repair sees the
// source, structural repair stays context-free, and the two must not drift the
// prompt-cache key away from the generate call that just paid for it.

const SHORT_DOC = 'Acme Corp reported total revenue of $12,345 in FY2025.';
const LONG_DOC = `ACME FY2025 FILING\n\nTotal revenue was $12,345 across all segments. ${'Section filler: the vendor reports quarterly figures net of returns. '.repeat(70)}\nClosing note: audited figures only.`;

function baseIR(doc: string): any {
  return {
    version: '0.2',
    entry: { class: 'Extractor', method: 'extract', source: 'extractor.cmb.rb' },
    model: { id: 'omlx:test', temperature: 0.1, max_tokens: 1200 },
    system: 'You extract vendor financials.',
    mode: 'single',
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding: { source: 'document', require_citations: true },
      security: {},
    },
    returnSchemaId: 'Extract',
    context: { document: doc },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{
      id: 'g1', type: 'Generate', prompt: 'Extract the vendor and its FY2025 total.',
      with: { context: 'doc' }, returns: 'Extract',
    }],
  };
}

const schema: any = { $id: 'Extract', type: 'object', additionalProperties: true };
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

afterEach(() => {
  delete process.env.CAMBIUM_ALLOW_MOCK;
});

describe('RED-175 — semantic repair gets the source', () => {
  it('passes the document to a citation repair, and names the task', async () => {
    const ir = baseIR(SHORT_DOC);
    const { calls, fn } = recorder(jsonOf({ summary: 'Acme', total: 12345 }));

    const repair = await handleRepair(
      jsonOf({ summary: 'Acme', total: 999 }),
      [{ instancePath: '/total', message: 'Grounding: value not supported by source' }],
      schema, ir, 1, fn, extractJson, ir.model,
      { documents: [], groundingTextByKey: { document: SHORT_DOC }, task: 'Extract the total.' },
    );

    expect(repair.parsed.total).toBe(12345);
    const call = calls[0];
    const seen = `${call.prompt}\n${call.cachedPrefix ?? ''}`;
    expect(seen).toContain('$12,345');                 // the material itself
    expect(seen).toContain('Extract the total.');      // what the output was for
    expect(seen).toContain('ORIGINAL_OUTPUT');
    expect(seen).toContain('Never delete a citation');
  });

  it('keeps structural repair context-free (byte-identical prompt)', async () => {
    const ir = baseIR(SHORT_DOC);
    const { calls, fn } = recorder(jsonOf({ summary: 'Acme' }));

    await handleRepair(
      jsonOf({ summry: 'Acme' }),
      [{ instancePath: '/', keyword: 'required', params: { missingProperty: 'summary' } }],
      schema, ir, 1, fn, extractJson,
    );

    const call = calls[0];
    expect(call.prompt).not.toContain('DOCUMENT:');
    expect(call.prompt).toContain('Acme');             // original output still travels
    expect(call.cachedPrefix).toBeUndefined();
    expect(call.documents).toBeUndefined();
    expect(call.system).toContain('You are repairing JSON');
  });

  it('reuses the generate call’s cached prefix instead of re-deriving it', async () => {
    const ir = baseIR(LONG_DOC);
    expect(LONG_DOC.length).toBeGreaterThan(MIN_CACHE_PREFIX_CHARS);
    const docInput = { documents: [], groundingTextByKey: { document: LONG_DOC } };

    const gen = recorder(jsonOf({ summary: 'Acme', total: 12345 }));
    await handleGenerate(ir.steps[0], ir, schema, gen.fn, extractJson, docInput);

    const rep = recorder(jsonOf({ summary: 'Acme', total: 12345 }));
    await handleRepair(
      jsonOf({ summary: 'Acme', total: 999 }),
      [{ instancePath: '/total', message: 'Grounding: value not supported by source' }],
      schema, ir, 1, rep.fn, extractJson, ir.model, docInput,
    );

    const g = gen.calls[0];
    const r = rep.calls[0];
    // Same assembler, same bytes: the repair hits the entry generate created.
    expect(r.system).toBe(g.system);
    expect(r.cachedPrefix).toBe(g.cachedPrefix);
    expect(r.cachedPrefix).toContain('DOCUMENT:');
  });

  it('records what repair saw, so the trace answers the question', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({
      ir: baseIR(SHORT_DOC),
      schemas: { Extract: schema },
      mock: true,
      resumeCandidate: { summary: 'x', citations: [{ quote: 'a fabricated quote not in the source' }] },
      parentRunId: 'run_src',
    });

    const repair = result.trace.steps.find((s: any) => s.type === 'Repair') as any;
    expect(repair).toBeDefined();
    // The complaint was about the source, and this time repair can read it.
    expect(repair.meta.source_chars).toBeGreaterThan(0);
    expect(repair.meta.source_chars).toBe(SHORT_DOC.length);
    // Plain-text grounding carries no document envelope.
    expect(repair.meta.source_docs).toBe(0);
    expect(repair.meta.source_doc_bytes).toBe(0);

    // The mock repair drops every citation, so the run must not be reported
    // clean. Handing repair the document removes the reason to delete; this
    // pin is the guard that catches a deletion anyway.
    const after = result.trace.steps.find((s: any) => s.type === 'GroundingCheckAfterRepair') as any;
    expect(after.meta.citations_before).toBe(1);
    expect(after.meta.citations_after).toBe(0);
    expect(after.meta.deleted_by_repair).toBe(true);
    expect(after.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  // A semantic pass whose source arrives as a native document envelope
  // (Anthropic PDF/image input) has no extracted text to measure, so
  // `source_chars` is legitimately 0 — the same value a context-free
  // structural pass reports. `source_docs` / `source_doc_bytes` are what keep
  // the two distinguishable, and they are the cost signal on that path.
  it('measures a native document envelope, not just extracted text', async () => {
    const ir = baseIR('');
    // `getGroundingDocument` refuses to stringify this shape, so the text
    // measure is 0 by construction here.
    ir.context = { document: { kind: 'base64_pdf', data: 'JVBERi0xLjQK', media_type: 'application/pdf' } };

    const documents = [{
      key: 'document',
      kind: 'base64_pdf' as const,
      data: 'JVBERi0xLjQK',
      media_type: 'application/pdf',
      decoded_bytes: 9,
    }];

    const rec = recorder(jsonOf({ summary: 'ok', citations: [] }));
    const semantic = await handleRepair(
      jsonOf({ summary: 'x', citations: [{ quote: 'not in the source' }] }),
      [{ message: 'quote not found in source' }],
      schema, ir, 1, rec.fn, extractJson, ir.model,
      { documents, groundingTextByKey: {}, task: 'Extract the vendor and its FY2025 total.' },
    );

    expect(semantic.result.meta!.source_chars).toBe(0);
    expect(semantic.result.meta!.source_docs).toBe(1);
    expect(semantic.result.meta!.source_doc_bytes).toBe(9);
    // The document really did travel with the request.
    expect(rec.calls[0].documents).toEqual(documents);

    // A structural pass over the same IR reports zero on every measure —
    // that triple is the "repair saw nothing" signal.
    const rec2 = recorder(jsonOf({ summary: 'ok', citations: [] }));
    const structural = await handleRepair(
      jsonOf({ summary: 'x' }), [{ message: 'missing required property' }],
      schema, ir, 1, rec2.fn, extractJson, ir.model,
    );
    expect(structural.result.meta!.source_chars).toBe(0);
    expect(structural.result.meta!.source_docs).toBe(0);
    expect(structural.result.meta!.source_doc_bytes).toBe(0);
    expect(rec2.calls[0].documents).toBeUndefined();
  });
});
