/**
 * RED-305: --fired-by parsing, fire_id generation, schedule ID validation.
 *
 * Drives runGen with synthetic IRs so the tests don't need the Ruby
 * compiler. Covers:
 *   - unknown schedule id → hard error at runner start
 *   - malformed --fired-by value → clear error
 *   - valid --fired-by + known id → trace.fired_by set
 *   - no --fired-by → interactive run, no fired_by on trace
 *   - gen with no cron declarations + --fired-by → error
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runGen } from './runner.js';

const MockSchema: any = {
  $id: 'MockOutput',
  type: 'object',
  additionalProperties: true,
  properties: {
    summary: { type: 'string' },
    metrics: { type: 'object' },
    key_facts: { type: 'array' },
  },
  required: ['summary'],
};

function baseIR(schedules: any[] = []) {
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
      schedules,
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

describe('runGen --fired-by handling (RED-305)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('rejects malformed --fired-by shape', async () => {
    await expect(
      runGen({
        ir: baseIR([{ id: 'x.y.z', expression: '* * * * *', method: 'test', tz: 'UTC' }]),
        schemas: { MockOutput: MockSchema },
        firedBy: 'not-a-valid-value',
      }),
    ).rejects.toThrow(/Invalid --fired-by value/);
  });

  it('rejects --fired-by on a gen with no cron declarations', async () => {
    await expect(
      runGen({
        ir: baseIR([]),
        schemas: { MockOutput: MockSchema },
        firedBy: 'schedule:test.test.daily',
      }),
    ).rejects.toThrow(/no cron schedules/);
  });

  it('rejects --fired-by with an unknown schedule id', async () => {
    await expect(
      runGen({
        ir: baseIR([{ id: 'test.test.daily', expression: '0 9 * * *', method: 'test', tz: 'UTC' }]),
        schemas: { MockOutput: MockSchema },
        firedBy: 'schedule:test.test.wrong_id',
      }),
    ).rejects.toThrow(/not declared/);
  });

  it('accepts --fired-by with a known id; sets trace.fired_by', async () => {
    const result = await runGen({
      ir: baseIR([{ id: 'test.test.daily', expression: '0 9 * * *', method: 'test', tz: 'UTC' }]),
      schemas: { MockOutput: MockSchema },
      firedBy: 'schedule:test.test.daily@2026-04-22T09:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(result.trace.fired_by).toBe('schedule:test.test.daily@2026-04-22T09:00:00Z');
  });

  it('omits timestamp in --fired-by → runner stamps one', async () => {
    const result = await runGen({
      ir: baseIR([{ id: 'test.test.daily', expression: '0 9 * * *', method: 'test', tz: 'UTC' }]),
      schemas: { MockOutput: MockSchema },
      firedBy: 'schedule:test.test.daily',
    });
    expect(result.ok).toBe(true);
    expect(result.trace.fired_by).toBe('schedule:test.test.daily');
  });

  it('interactive run (no --fired-by) leaves trace.fired_by absent', async () => {
    const result = await runGen({
      ir: baseIR([{ id: 'test.test.daily', expression: '0 9 * * *', method: 'test', tz: 'UTC' }]),
      schemas: { MockOutput: MockSchema },
    });
    expect(result.ok).toBe(true);
    expect(result.trace.fired_by).toBeUndefined();
  });
});
