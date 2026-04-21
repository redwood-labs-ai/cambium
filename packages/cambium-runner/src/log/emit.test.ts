/**
 * RED-302: emit.ts — event classification, payload filtering, fan-out
 * ordering, sink-error containment, granularity filtering.
 */
import { describe, it, expect } from 'vitest';
import {
  emitLogEvent,
  buildRunLogEvent,
  classifyRunOutcome,
  snakeCase,
} from './emit.js';
import type { LogEvent, LogSink, LogDestination } from './event.js';

describe('snakeCase', () => {
  it('converts CamelCase to snake_case', () => {
    expect(snakeCase('PatternExtractor')).toBe('pattern_extractor');
    expect(snakeCase('JWTValidator')).toBe('jwt_validator');
    expect(snakeCase('HTTPCallHandler')).toBe('http_call_handler');
    expect(snakeCase('MyGen')).toBe('my_gen');
    expect(snakeCase('already_snake')).toBe('already_snake');
  });
});

describe('classifyRunOutcome', () => {
  it('finalOk true + no warnings → complete', () => {
    expect(classifyRunOutcome(true, { steps: [] }, false)).toEqual({ event: 'complete' });
  });

  it('finalOk true + CorrectAcceptedWithErrors → complete_with_warnings', () => {
    expect(
      classifyRunOutcome(
        true,
        { steps: [{ type: 'CorrectAcceptedWithErrors', ok: false }] },
        false,
      ),
    ).toEqual({ event: 'complete_with_warnings' });
  });

  it('budget exceeded → failed with reason budget_exceeded', () => {
    expect(classifyRunOutcome(false, { steps: [] }, true)).toEqual({
      event: 'failed',
      reason: 'budget_exceeded',
    });
  });

  it('finalOk false + ValidateAfterCorrect false → failed with reason schema_broke_after_corrector', () => {
    expect(
      classifyRunOutcome(
        false,
        { steps: [{ type: 'ValidateAfterCorrect', ok: false }] },
        false,
      ),
    ).toEqual({ event: 'failed', reason: 'schema_broke_after_corrector' });
  });

  it('finalOk false + generic validation failure → failed with reason validation_failed', () => {
    expect(
      classifyRunOutcome(
        false,
        { steps: [{ type: 'ValidateAfterRepair', ok: false }] },
        false,
      ),
    ).toEqual({ event: 'failed', reason: 'validation_failed' });
  });

  it('finalOk false + no failing step found → failed with reason error', () => {
    expect(classifyRunOutcome(false, { steps: [] }, false)).toEqual({
      event: 'failed',
      reason: 'error',
    });
  });
});

describe('buildRunLogEvent', () => {
  it('constructs a dot-notation event name', () => {
    const ev = buildRunLogEvent({
      genClass: 'PatternExtractor',
      method: 'extract',
      event: 'complete',
      runId: 'run_1',
      ok: true,
    });
    expect(ev.event_name).toBe('pattern_extractor.extract.complete');
    expect(ev.gen).toBe('pattern_extractor');
    expect(ev.method).toBe('extract');
  });

  it('includes signals extracted from the trace', () => {
    const ev = buildRunLogEvent({
      genClass: 'G', method: 'm', event: 'complete', runId: 'r', ok: true,
      trace: {
        steps: [
          { type: 'ExtractSignals', meta: { signals: { severity: 'critical', foo: 'bar' } } },
        ],
      },
    });
    expect(ev.signals).toEqual({ severity: 'critical', foo: 'bar' });
  });

  it('counts tool calls per tool name', () => {
    const ev = buildRunLogEvent({
      genClass: 'G', method: 'm', event: 'complete', runId: 'r', ok: true,
      trace: {
        steps: [
          { type: 'ToolCall', meta: { tool: 'calculator' } },
          { type: 'ToolCall', meta: { tool: 'calculator' } },
          { type: 'ToolCall', meta: { tool: 'web_search' } },
        ],
      },
    });
    expect(ev.tool_calls).toEqual({ calculator: 2, web_search: 1 });
  });

  it('counts repairs', () => {
    const ev = buildRunLogEvent({
      genClass: 'G', method: 'm', event: 'complete', runId: 'r', ok: true,
      trace: {
        steps: [
          { type: 'Repair' },
          { type: 'Repair' },
          { type: 'Generate' },
        ],
      },
    });
    expect(ev.repair_attempts).toBe(2);
  });

  it('omits absent field groups', () => {
    const ev = buildRunLogEvent({
      genClass: 'G', method: 'm', event: 'complete', runId: 'r', ok: true,
    });
    expect(ev.signals).toBeUndefined();
    expect(ev.tool_calls).toBeUndefined();
    expect(ev.repair_attempts).toBeUndefined();
  });
});

describe('emitLogEvent fan-out', () => {
  const baseEvent: LogEvent = {
    event_name: 'g.m.complete',
    gen: 'g',
    method: 'm',
    event: 'complete',
    run_id: 'r1',
    ok: true,
    signals: { severity: 'high' },
    tool_calls: { web_search: 2 },
  };

  it('filters payload to framework-always + dest.include per destination', async () => {
    const captured: Array<{ dest: string; payload: LogEvent }> = [];
    const sink: LogSink = async (event, dest) => {
      captured.push({ dest: dest.destination, payload: event });
    };

    await emitLogEvent(baseEvent, {
      destinations: [
        { destination: 'a', include: [], granularity: 'run' },
        { destination: 'b', include: ['signals'], granularity: 'run' },
      ],
      sinks: { a: sink, b: sink },
      pushStep: () => {},
    });

    expect(captured).toHaveLength(2);
    const a = captured.find((c) => c.dest === 'a')!.payload;
    const b = captured.find((c) => c.dest === 'b')!.payload;
    // Framework-always always present:
    expect(a.event_name).toBe('g.m.complete');
    expect(b.event_name).toBe('g.m.complete');
    // include: [] drops signals and tool_calls:
    expect(a.signals).toBeUndefined();
    expect(a.tool_calls).toBeUndefined();
    // include: ['signals'] keeps signals, drops tool_calls:
    expect(b.signals).toEqual({ severity: 'high' });
    expect(b.tool_calls).toBeUndefined();
  });

  it('emits LogEmitted on success', async () => {
    const steps: any[] = [];
    await emitLogEvent(baseEvent, {
      destinations: [{ destination: 'ok', include: [], granularity: 'run' }],
      sinks: { ok: async () => {} },
      pushStep: (s) => steps.push(s),
    });
    expect(steps).toEqual([
      expect.objectContaining({
        type: 'LogEmitted',
        ok: true,
        meta: expect.objectContaining({ destination: 'ok', event_name: 'g.m.complete' }),
      }),
    ]);
  });

  it('converts sink errors into LogFailed steps (no propagation)', async () => {
    const steps: any[] = [];
    await expect(
      emitLogEvent(baseEvent, {
        destinations: [{ destination: 'broken', include: [], granularity: 'run' }],
        sinks: { broken: async () => { throw new Error('dd ingest down'); } },
        pushStep: (s) => steps.push(s),
      }),
    ).resolves.toBeUndefined();
    expect(steps).toEqual([
      expect.objectContaining({
        type: 'LogFailed',
        ok: false,
        meta: expect.objectContaining({
          destination: 'broken',
          reason: 'dd ingest down',
        }),
      }),
    ]);
  });

  it('reports unknown-destination as LogFailed with clear reason', async () => {
    const steps: any[] = [];
    await emitLogEvent(baseEvent, {
      destinations: [{ destination: 'honeycomb', include: [], granularity: 'run' }],
      sinks: { stdout: async () => {}, datadog: async () => {} },
      pushStep: (s) => steps.push(s),
    });
    expect(steps).toEqual([
      expect.objectContaining({
        type: 'LogFailed',
        ok: false,
        meta: expect.objectContaining({
          destination: 'honeycomb',
          reason: expect.stringContaining('unknown destination'),
        }),
      }),
    ]);
  });

  it('filters by granularity — run-level events skip step destinations', async () => {
    const captured: string[] = [];
    await emitLogEvent(baseEvent, {
      destinations: [
        { destination: 'run_dest', include: [], granularity: 'run' },
        { destination: 'step_dest', include: [], granularity: 'step' },
      ],
      sinks: {
        run_dest: async () => { captured.push('run_dest'); },
        step_dest: async () => { captured.push('step_dest'); },
      },
      pushStep: () => {},
    });
    expect(captured).toEqual(['run_dest']);
  });

  it('filters by granularity — step-level events skip run destinations', async () => {
    const captured: string[] = [];
    const stepEvent: LogEvent = { ...baseEvent, event: 'tool_call' };
    await emitLogEvent(stepEvent, {
      destinations: [
        { destination: 'run_dest', include: [], granularity: 'run' },
        { destination: 'step_dest', include: [], granularity: 'step' },
      ],
      sinks: {
        run_dest: async () => { captured.push('run_dest'); },
        step_dest: async () => { captured.push('step_dest'); },
      },
      pushStep: () => {},
    });
    expect(captured).toEqual(['step_dest']);
  });
});
