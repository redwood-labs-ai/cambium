/**
 * #169 end to end: a gen grounded in Markdown or JSON, with a `format:`,
 * verifies the quotes a model actually writes — and the same gen without
 * a `format:` behaves exactly as it did before.
 *
 * Same harness as grounding-citations-repair.test.ts: `resumeCandidate`
 * stands in for the model's output, so no provider is touched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runGen } from './runner.js';
import type { CorrectorFn } from './correctors/types.js';

const PermissiveSchema: any = {
  $id: 'Extract',
  type: 'object',
  additionalProperties: true,
};

const MARKDOWN_DOC = [
  '# Q3 summary',
  '',
  'Revenue grew **12%** in Q3, and the [quarterly report](https://example.com/q3) has the detail.',
].join('\n');

const COMPACT_JSON_DOC =
  '{"status":"degraded","note":"Restarted twice.\\nStill \\"flapping\\".","host":"web-04"}';

function baseIR(grounding: Record<string, any>, context: Record<string, any>): any {
  return {
    version: '0.2',
    entry: { class: 'Extractor', method: 'extract', source: 'extractor.cmb.rb' },
    model: { id: 'omlx:test', temperature: 0.1, max_tokens: 100 },
    system: 'test',
    mode: 'single',
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding,
      security: {},
    },
    returnSchemaId: 'Extract',
    context,
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{ id: 'g1', type: 'Generate', prompt: 'extract', with: { context: 'doc' }, returns: 'Extract' }],
  };
}

async function run(ir: any, resumeCandidate: any, correctors?: Record<string, CorrectorFn>) {
  process.env.CAMBIUM_ALLOW_MOCK = '1';
  return runGen({
    ir,
    schemas: { Extract: PermissiveSchema },
    mock: true,
    resumeCandidate,
    parentRunId: 'run_src',
    ...(correctors ? { correctors } : {}),
  });
}

const stepOfType = (result: any, type: string) =>
  result.trace.steps.find((s: any) => s.type === type);

afterEach(() => {
  delete process.env.CAMBIUM_ALLOW_MOCK;
});

describe('#169: grounded_in format: markdown', () => {
  const candidate = {
    summary: 'Q3 revenue',
    citations: [{ quote: 'Revenue grew 12% in Q3' }],
  };

  it('without format:, a correct visible-text quote is rejected as fabricated', async () => {
    const result = await run(
      baseIR({ source: 'notes', require_citations: true }, { notes: MARKDOWN_DOC }),
      candidate,
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(false);
    expect(check.meta.failed).toBe(1);
    // No format declared → no format/derived keys at all (existing traces
    // are byte-for-byte what they were).
    expect('format' in check.meta).toBe(false);
    expect('derived' in check.meta).toBe(false);
  });

  it('with format: markdown, the same quote verifies via the derived view', async () => {
    const result = await run(
      baseIR({ source: 'notes', require_citations: true, format: 'markdown' }, { notes: MARKDOWN_DOC }),
      candidate,
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(true);
    expect(check.meta.format).toBe('markdown');
    expect(check.meta.derived).toBe(true);
    expect(check.meta.citationResult.passed[0].matched_via).toBe('derived');
    // Nothing to repair, so the after-repair branch never runs.
    expect(stepOfType(result, 'GroundingCheckAfterRepair')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('a quote of the literal markup still matches the raw document first', async () => {
    const result = await run(
      baseIR({ source: 'notes', require_citations: true, format: 'markdown' }, { notes: MARKDOWN_DOC }),
      { summary: 'Q3 revenue', citations: [{ quote: 'Revenue grew **12%** in Q3' }] },
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(true);
    expect(check.meta.citationResult.passed[0].matched_via).toBe('document');
  });

  it('a genuinely fabricated quote still fails with a format set', async () => {
    const result = await run(
      baseIR({ source: 'notes', require_citations: true, format: 'markdown' }, { notes: MARKDOWN_DOC }),
      { summary: 'x', citations: [{ quote: 'Revenue fell 40% in Q4' }] },
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(false);
    expect(check.meta.format).toBe('markdown');
    expect(check.meta.derived).toBe(true);
  });
});

describe('#169: grounded_in format: json', () => {
  it('verifies a key/value fragment quoted pretty against a compact source', async () => {
    const result = await run(
      baseIR({ source: 'payload', require_citations: true, format: 'json' }, { payload: COMPACT_JSON_DOC }),
      { summary: 'degraded', citations: [{ quote: '"status": "degraded"' }] },
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(true);
    expect(check.meta.format).toBe('json');
    expect(check.meta.derived).toBe(true);
    expect(check.meta.citationResult.passed[0].matched_via).toBe('derived');
  });

  it('verifies a quote that decodes an escaped quote inside a string value', async () => {
    const result = await run(
      baseIR({ source: 'payload', require_citations: true, format: 'json' }, { payload: COMPACT_JSON_DOC }),
      { summary: 'flapping', citations: [{ quote: 'Still "flapping"' }] },
    );
    expect(stepOfType(result, 'GroundingCheck').ok).toBe(true);
  });

  it('verify: field_values passes on a string field carrying escapes', async () => {
    const result = await run(
      baseIR(
        { source: 'payload', require_citations: false, verify: 'field_values', format: 'json' },
        { payload: COMPACT_JSON_DOC },
      ),
      { note: 'Restarted twice.\nStill "flapping".', host: 'web-04' },
    );
    const check = stepOfType(result, 'GroundingFieldValueCheck');
    expect(check.ok).toBe(true);
    expect(check.meta.format).toBe('json');
    expect(check.meta.derived).toBe(true);
    const viaDerived = check.meta.fieldValuesResult.passed
      .filter((p: any) => p.matched_via === 'derived')
      .map((p: any) => p.path);
    expect(viaDerived).toEqual(['note']);
  });

  it('the same field_values case fails without a format (pins the gap)', async () => {
    const result = await run(
      baseIR(
        { source: 'payload', require_citations: false, verify: 'field_values' },
        { payload: COMPACT_JSON_DOC },
      ),
      { note: 'Restarted twice.\nStill "flapping".', host: 'web-04' },
    );
    const check = stepOfType(result, 'GroundingFieldValueCheck');
    expect(check.ok).toBe(false);
    expect('format' in check.meta).toBe(false);
  });

  it('unparseable JSON derives nothing, and that is not a failure', async () => {
    const result = await run(
      baseIR(
        { source: 'payload', require_citations: true, format: 'json' },
        { payload: 'this is not JSON at all, but it is a document' },
      ),
      { summary: 'x', citations: [{ quote: 'not JSON at all' }] },
    );
    const check = stepOfType(result, 'GroundingCheck');
    // Raw-only verification, exactly as before the format was declared.
    expect(check.ok).toBe(true);
    expect(check.meta.format).toBe('json');
    expect(check.meta.derived).toBe(false);
    expect(check.meta.citationResult.passed[0].matched_via).toBe('document');
  });
});

// ── A-004 (AUD-002): each verification site gets its own context ──────
//
// `runCorrectorPipeline` hands the context object straight to user code.
// While the four grounding sites shared one instance, a workspace corrector
// that treated its `context` argument as scratch space could neutralize
// grounding for the whole run — in either direction. Both repros below are
// the auditor's, and both are impossible on main, where every site built a
// fresh object literal.
describe('#169: a corrector cannot poison the grounding context (A-004)', () => {
  const PLAIN_DOC = 'The vendor is Acme and the total is 12345 dollars.';
  const FABRICATION = 'Revenue tripled and every SLA was met.';

  function irWithCorrector(): any {
    const ir = baseIR({ source: 'document', require_citations: true }, { document: PLAIN_DOC });
    ir.policies.correctors = [{ name: 'poisoner', max_attempts: 1 }];
    return ir;
  }

  it('injecting derivedDocument does not launder a fabricated citation', async () => {
    const injector: CorrectorFn = (data, context) => {
      (context as any).derivedDocument = FABRICATION;
      return { corrected: false, output: data, issues: [] };
    };
    const result = await run(
      irWithCorrector(),
      { summary: 'x', citations: [{ quote: FABRICATION }] },
      { poisoner: injector },
    );
    const check = stepOfType(result, 'GroundingCheck');
    // The gen declares no format at all — there is no derived view to be had.
    expect(check.ok).toBe(false);
    expect(check.meta.failed).toBe(1);
    expect(check.meta.passed).toBe(0);
  });

  it('blanking document does not fail a correct citation', async () => {
    const eraser: CorrectorFn = (data, context) => {
      (context as any).document = '';
      return { corrected: false, output: data, issues: [] };
    };
    const result = await run(
      irWithCorrector(),
      { summary: 'x', citations: [{ quote: 'The vendor is Acme' }] },
      { poisoner: eraser },
    );
    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(true);
    expect(check.meta.passed).toBe(1);
    expect(result.ok).toBe(true);
  });
});

// ── AUD-006: the after-repair steps carry the format meta too ─────────
describe('#169: GroundingCheckAfterRepair carries the format meta', () => {
  it('reports format + derived alongside the RED-175 deletion counts', async () => {
    const result = await run(
      baseIR({ source: 'notes', require_citations: true, format: 'markdown' }, { notes: MARKDOWN_DOC }),
      {
        summary: 'Q3',
        citations: [
          // Verifies only against the derived view...
          { quote: 'Revenue grew 12% in Q3' },
          // ...and this one verifies nowhere, so it drives the repair.
          { quote: 'Revenue fell 40% in Q4' },
        ],
      },
    );

    const check = stepOfType(result, 'GroundingCheck');
    expect(check.ok).toBe(false);
    expect(check.meta.totalChecked).toBe(2);
    expect(check.meta.passed).toBe(1);
    expect(check.meta.citationResult.passed[0].matched_via).toBe('derived');

    const after = stepOfType(result, 'GroundingCheckAfterRepair');
    expect(after).toBeDefined();
    expect(after.meta.format).toBe('markdown');
    expect(after.meta.derived).toBe(true);
    // The deterministic mock repair returns output with no citations at all,
    // so this is the RED-175 deletion shape: fail closed, at the step and at
    // the API boundary. The counts are computed over the mixed raw+derived
    // population the first check saw.
    expect(after.meta.citations_before).toBe(2);
    expect(after.meta.citations_after).toBe(0);
    expect(after.meta.deleted_by_repair).toBe(true);
    expect(after.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
