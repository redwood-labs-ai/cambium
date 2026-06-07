import { describe, it, expect, afterEach } from 'vitest';
import { runGen } from './runner.js';

// RED-398 (AUD-001): the citations grounding path re-verifies after a repair
// and emits GroundingCheckAfterRepair. This branch shipped with no committed
// coverage; this file pins it. It is the citations analogue of the
// after-repair tests in grounding-field-values.test.ts.

const PermissiveSchema: any = {
  $id: 'Extract',
  type: 'object',
  additionalProperties: true,
};

function baseIR(): any {
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
      // citations-only grounding: step 5 runs, step 5b (field-values) is skipped.
      grounding: { source: 'document', require_citations: true },
      security: {},
    },
    returnSchemaId: 'Extract',
    context: { document: 'The vendor is Acme and the total is 12345 dollars.' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{ id: 'g1', type: 'Generate', prompt: 'extract', with: { context: 'doc' }, returns: 'Extract' }],
  };
}

afterEach(() => {
  delete process.env.CAMBIUM_ALLOW_MOCK;
});

describe('grounded_in require_citations — citation repair re-verify (RED-398)', () => {
  it('emits GroundingCheckAfterRepair after a citation repair passes schema revalidation', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({
      ir: baseIR(),
      schemas: { Extract: PermissiveSchema },
      mock: true,
      // A fabricated quote not in the doc → citations check fails → repair fires.
      resumeCandidate: { summary: 'x', citations: [{ quote: 'a fabricated quote not in the source' }] },
      parentRunId: 'run_src',
    });

    const types = result.trace.steps.map((s: any) => s.type);
    // Initial check failed and fed a repair...
    expect(types).toContain('GroundingCheck');
    expect(types).toContain('Repair');
    expect(types).toContain('ValidateAfterGrounding');
    // ...and the re-verify branch ran.
    const after = result.trace.steps.find((s: any) => s.type === 'GroundingCheckAfterRepair');
    expect(after).toBeDefined();
    // The deterministic mock repair emits an output with no `citations` field,
    // so the re-verify has nothing to check and reports clean (totalChecked: 0).
    // This pins that the branch fires; on this clean path the ok/meta values
    // alone cannot distinguish the citationResult computation from its
    // defensive fallback (no-error-issues), so we also pin that citationResult
    // survived the corrector→handleCorrect meta plumbing — RED-323 broke
    // exactly that once, silently. The ok:false-after-repair computation is
    // covered by the structurally identical field-values test (the mock can't
    // re-emit a fabricated citation).
    expect(after.ok).toBe(true);
    expect(after.meta.totalChecked).toBe(0);
    expect(after.meta.citationResult).toBeDefined();
  });
});
