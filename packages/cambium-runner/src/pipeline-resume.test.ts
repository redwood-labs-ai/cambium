import { describe, it, expect } from 'vitest';
import { planPipelineResume, rehydrateFromEntries } from './pipeline.js';

// RED-385 Phase B: pipeline replay resume planning. Index-based matching
// (priorTrace.operators[i] ↔ operators[i]); resume at the first operator
// whose prior entry isn't ok:true; rehydrate stepResults from reused
// operator outputs (recursing into branch_on bodies).

const OPS = [
  { kind: 'Step', id: 'recon' },
  { kind: 'FanOut', id: 'reviewers' },
  { kind: 'Step', id: 'fix' },
];

function entry(id: string, ok: boolean, output?: unknown) {
  return { type: 'PipelineStep', id, ok, ...(output !== undefined ? { output } : {}) };
}

describe('planPipelineResume — default (first incomplete operator)', () => {
  it('resumes at the first operator whose prior entry is not ok:true', () => {
    const prior = { operators: [entry('recon', true, { m: 1 }), entry('reviewers', false)] };
    const plan = planPipelineResume(OPS, prior, null);
    expect(plan.resumeOpId).toBe('reviewers');
    expect(plan.reusedEntries.map((e) => e.id)).toEqual(['recon']);
    expect(plan.toDispatch.map((o) => o.id)).toEqual(['reviewers', 'fix']);
  });

  it('treats a missing entry (run stopped early) as the resume point', () => {
    // recon ok, then the run crashed before reviewers — only one entry.
    const prior = { operators: [entry('recon', true, { m: 1 })] };
    const plan = planPipelineResume(OPS, prior, null);
    expect(plan.resumeOpId).toBe('reviewers');
    expect(plan.reusedEntries.map((e) => e.id)).toEqual(['recon']);
  });

  it('treats a PipelineBudgetExceeded entry (no ok:true) as incomplete', () => {
    const prior = {
      operators: [entry('recon', true, { m: 1 }), { type: 'PipelineBudgetExceeded', id: 'reviewers' }],
    };
    const plan = planPipelineResume(OPS, prior, null);
    expect(plan.resumeOpId).toBe('reviewers');
  });

  it('errors when the prior run completed every operator (nothing to resume)', () => {
    const prior = {
      operators: [entry('recon', true, {}), entry('reviewers', true, []), entry('fix', true, {})],
    };
    expect(() => planPipelineResume(OPS, prior, null)).toThrow(/nothing to resume/);
  });
});

describe('planPipelineResume — explicit --from-op', () => {
  it('resumes at the named operator, reusing everything before it', () => {
    const prior = {
      operators: [entry('recon', true, { m: 1 }), entry('reviewers', true, []), entry('fix', true, {})],
    };
    const plan = planPipelineResume(OPS, prior, 'fix');
    expect(plan.resumeOpId).toBe('fix');
    expect(plan.reusedEntries.map((e) => e.id)).toEqual(['recon', 'reviewers']);
    expect(plan.toDispatch.map((o) => o.id)).toEqual(['fix']);
  });

  it('errors if a reused (pre-resume) operator did not succeed', () => {
    const prior = { operators: [entry('recon', false), entry('reviewers', false)] };
    expect(() => planPipelineResume(OPS, prior, 'fix')).toThrow(/did not succeed/);
  });
});

describe('rehydrateFromEntries', () => {
  it('rehydrates step + fan_out outputs by id', () => {
    const sr: Record<string, any> = {};
    rehydrateFromEntries([entry('recon', true, { m: 1 }), entry('reviewers', true, ['a', 'b'])], sr);
    expect(sr).toEqual({ recon: { m: 1 }, reviewers: ['a', 'b'] });
  });

  it('recurses into branch_on bodies (branch_on itself adds no key)', () => {
    const sr: Record<string, any> = {};
    const branchOn = {
      type: 'PipelineBranchOn',
      operators: [entry('nested_fix', true, { patched: true })],
    };
    rehydrateFromEntries([entry('triage', true, { sev: 'high' }), branchOn], sr);
    expect(sr).toEqual({ triage: { sev: 'high' }, nested_fix: { patched: true } });
  });

  it('skips entries with no output (a branch_on entry carries none of its own)', () => {
    const sr: Record<string, any> = {};
    rehydrateFromEntries([{ type: 'PipelineBranchOn', operators: [] }], sr);
    expect(sr).toEqual({});
  });
});
