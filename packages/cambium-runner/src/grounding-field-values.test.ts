import { describe, it, expect, afterEach } from 'vitest';
import { runGen } from './runner.js';
import { builtinCorrectors } from './correctors/index.js';

// RED-392: runner integration for `grounded_in verify: :field_values`.
// Exercises runGen's step 5b: the GroundingFieldValueCheck trace step and
// the repair feed. We use `resumeCandidate` (RED-312) to seed an exact
// candidate so the field-value check is deterministic without depending on
// mock-generate's output shape.

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
      // verify-only grounding: step 5 (citations) is skipped, step 5b runs.
      grounding: { source: 'document', require_citations: false, verify: 'field_values' },
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

describe('grounded_in verify: :field_values — runner step 5b (RED-392)', () => {
  it('emits GroundingFieldValueCheck ok:true and fires no repair when all values are in the doc', async () => {
    const result = await runGen({
      ir: baseIR(),
      schemas: { Extract: PermissiveSchema },
      // every leaf value appears in the document → grounded
      resumeCandidate: { vendor: 'Acme', total: 12345 },
      parentRunId: 'run_src',
      // no mock needed: resumeCandidate skips Generate and the candidate
      // passes the field-value check, so no model call ever happens.
    });

    const types = result.trace.steps.map((s: any) => s.type);
    expect(types).toContain('GroundingFieldValueCheck');
    expect(types).not.toContain('Repair');

    const fv = result.trace.steps.find((s: any) => s.type === 'GroundingFieldValueCheck');
    expect(fv.ok).toBe(true);
    expect(fv.meta.failed).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('emits GroundingFieldValueCheck ok:false and feeds a repair when a value is not in the doc', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({
      ir: baseIR(),
      schemas: { Extract: PermissiveSchema },
      mock: true,
      // "Globex" is NOT in the document → ungrounded → repair fires
      resumeCandidate: { vendor: 'Globex', total: 12345 },
      parentRunId: 'run_src',
    });

    const types = result.trace.steps.map((s: any) => s.type);
    const fv = result.trace.steps.find((s: any) => s.type === 'GroundingFieldValueCheck');
    expect(fv.ok).toBe(false);
    expect(fv.meta.failed).toBeGreaterThan(0);
    // the field-value error is fed into the repair loop
    expect(types).toContain('Repair');
    expect(types).toContain('ValidateAfterGroundingValues');
  });

  // RED-398: after a field-values repair passes schema revalidation, the
  // corrector re-runs and emits GroundingFieldValueCheckAfterRepair. These
  // tests pin that branch (AUD-001 — it shipped with no committed coverage).
  it('emits GroundingFieldValueCheckAfterRepair ok:false when the repair leaves a value ungrounded', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({
      ir: baseIR(),
      schemas: { Extract: PermissiveSchema },
      mock: true,
      // "Globex" is ungrounded → repair fires; the deterministic mock repair
      // emits a summary string that is itself not in the doc → re-verify fails.
      resumeCandidate: { vendor: 'Globex', total: 12345 },
      parentRunId: 'run_src',
    });

    const after = result.trace.steps.find(
      (s: any) => s.type === 'GroundingFieldValueCheckAfterRepair',
    );
    expect(after).toBeDefined();
    expect(after.ok).toBe(false);
    expect(after.meta.failed).toBeGreaterThan(0);
  });

  it('emits GroundingFieldValueCheckAfterRepair ok:true when the repair lands a grounded value', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const ir = baseIR();
    // Document contains the deterministic mock repair's summary string, so the
    // post-repair candidate's only checked leaf is grounded → re-verify passes.
    ir.context.document = 'Report. Mock analysis (model provider not available).';
    const result = await runGen({
      ir,
      schemas: { Extract: PermissiveSchema },
      mock: true,
      // "Globex" is not in the doc → initial check fails → repair fires.
      resumeCandidate: { vendor: 'Globex' },
      parentRunId: 'run_src',
    });

    const after = result.trace.steps.find(
      (s: any) => s.type === 'GroundingFieldValueCheckAfterRepair',
    );
    expect(after).toBeDefined();
    expect(after.ok).toBe(true);
    expect(after.meta.failed).toBe(0);
  });

  it('does not run step 5b when verify is absent (citations-only / no verify)', async () => {
    const ir = baseIR();
    ir.policies.grounding = { source: 'document', require_citations: false }; // no verify
    const result = await runGen({
      ir,
      schemas: { Extract: PermissiveSchema },
      resumeCandidate: { vendor: 'Globex' }, // would fail field-values, but check is off
      parentRunId: 'run_src',
    });
    const types = result.trace.steps.map((s: any) => s.type);
    expect(types).not.toContain('GroundingFieldValueCheck');
    expect(result.ok).toBe(true);
  });
});
