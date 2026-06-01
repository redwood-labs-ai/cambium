import { describe, it, expect } from 'vitest';
import { runGen } from './runner.js';

// RED-312: library-level replay core. `runGen({ resumeCandidate })`
// skips Generate (and the agentic tool loop) and runs the cheap
// deterministic tail against the candidate. These tests deliberately
// run WITHOUT mock mode and without a model backend: if Generate were
// to fire, it would fail to reach a provider. A clean, schema-valid
// result therefore proves no LLM/tool call happened.

const MockSchema: any = {
  $id: 'MockOutput',
  type: 'object',
  additionalProperties: true,
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
};

function baseIR() {
  return {
    version: '0.2',
    entry: { class: 'Test', method: 'test', source: 'test.cmb.rb' },
    model: { id: 'omlx:test-model', temperature: 0.1, max_tokens: 100 },
    system: 'test system',
    mode: 'single' as const,
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding: null,
      security: {},
    },
    returnSchemaId: 'MockOutput',
    context: { document: 'test document' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [
      {
        id: 'generate_1',
        type: 'Generate' as const,
        prompt: 'say something',
        with: { context: 'test document' },
        returns: 'MockOutput',
      },
    ],
  };
}

describe('replay core — runGen({ resumeCandidate }) (RED-312)', () => {
  it('resumes from a valid candidate without firing Generate or contacting a backend', async () => {
    const candidate = { summary: 'a hand-supplied valid output' };

    const result = await runGen({
      ir: baseIR(),
      schemas: { MockOutput: MockSchema },
      resumeCandidate: candidate,
      parentRunId: 'run_original_abc',
      // NOTE: no `mock: true`, no CAMBIUM_ALLOW_MOCK. A successful run
      // here is only possible because Generate is skipped.
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(candidate);

    const stepTypes = result.trace.steps.map((s: any) => s.type);
    expect(stepTypes).toContain('ReplayResume');
    expect(stepTypes).not.toContain('Generate');
  });

  it('records parent_run_id on the replay trace for lineage', async () => {
    const result = await runGen({
      ir: baseIR(),
      schemas: { MockOutput: MockSchema },
      resumeCandidate: { summary: 'ok' },
      parentRunId: 'run_parent_123',
    });

    expect(result.trace.parent_run_id).toBe('run_parent_123');
  });

  it('annotates the ReplayResume step with the checkpoint origin', async () => {
    const result = await runGen({
      ir: baseIR(),
      schemas: { MockOutput: MockSchema },
      resumeCandidate: { summary: 'ok' },
      resumeFromStep: 'Correct',
      parentRunId: 'run_parent_123',
    });

    const resume = result.trace.steps.find((s: any) => s.type === 'ReplayResume');
    expect(resume).toBeTruthy();
    expect(resume.meta.from_step).toBe('Correct');
    expect(resume.meta.parent_run_id).toBe('run_parent_123');
  });

  it('a normal run (no resumeCandidate) still fires Generate', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    try {
      const result = await runGen({
        ir: baseIR(),
        schemas: { MockOutput: MockSchema },
        mock: true,
      });
      const stepTypes = result.trace.steps.map((s: any) => s.type);
      expect(stepTypes).toContain('Generate');
      expect(stepTypes).not.toContain('ReplayResume');
    } finally {
      delete process.env.CAMBIUM_ALLOW_MOCK;
    }
  });
});
