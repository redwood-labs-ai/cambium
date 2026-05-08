/**
 * RED-220 POC follow-up: proves runGen is callable as a library, returns
 * a structured RunGenResult, and that importing runner.ts does NOT fire
 * its CLI main(). The first real engine-mode POC surfaced both gaps:
 *   - main() at the bottom of runner.ts always ran, even on import,
 *     causing a "Missing --ir" error before runGen could even be reached.
 *   - opts.mock didn't actually wire through; mockGenerate is gated on
 *     CAMBIUM_ALLOW_MOCK=1 only.
 *
 * If this test ever fails for the import-side reason, the symptom would
 * be a thrown "Missing --ir" before the test body even runs.
 */
import { describe, it, expect } from 'vitest';
import { runGen, type RunGenOptions, type IR } from '../../cambium-runner/src/index.js';
import { Type } from '@sinclair/typebox';

const MockReport = Type.Object(
  {
    summary: Type.String(),
    metrics: Type.Optional(Type.Object({ latency_ms_samples: Type.Array(Type.Number()) })),
    key_facts: Type.Optional(Type.Array(Type.Any())),
  },
  { additionalProperties: false, $id: 'MockReport' },
);

// Minimal valid IR for these tests. Mirrors the shape the Ruby compiler
// emits for a single-step generate gen. Fields not exercised here are
// either absent or empty.
function minimalIr(returnSchemaId: string) {
  return {
    version: '0.2',
    entry: { class: 'LibrarySmokeTest', method: 'analyze', source: '<test>' },
    model: { id: 'omlx:stub', temperature: 0.0, max_tokens: 256 },
    system: 'You are a stub.',
    mode: null,
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding: null,
      security: null,
      budget: null,
      memory: [],
      memory_pools: {},
      memory_write_via: null,
    },
    reads_trace_of: null,
    returnSchemaId,
    context: { document: 'placeholder' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{
      id: 'generate_1',
      type: 'Generate',
      prompt: 'do the thing',
      with: { context: '' },
      returns: returnSchemaId,
    }],
  };
}

describe('runGen library entry (RED-220 POC follow-up)', () => {
  it('importing the package does not fire CLI main() (no "Missing --ir" thrown on import)', () => {
    // The fact that `import { runGen } ...` at the top of this file did
    // not throw is the actual assertion. This `it` exists so the
    // invariant is named in the test report.
    expect(typeof runGen).toBe('function');
  });

  it('exports IR as a type (RED-354)', () => {
    // Use the imported type to confirm it resolves and accepts the
    // shape the Ruby compiler emits. This is a compile-time check —
    // the runtime body of the `it` only proves the bound name exists
    // and the assignment typechecks. If `IR` weren't exported from
    // the runner, the import at the top of this file would fail to
    // type-check, and TypeScript would surface that during test build.
    const typed: IR = minimalIr('MockReport');
    expect(typed.entry?.class).toBe('LibrarySmokeTest');
  });

  it('rejects a path-traversal runId (RED-330 security guard)', async () => {
    // opts.runId joins into `runs/<runId>/...` for the eager mkdir +
    // stderr emit and into per-step trace refs. node:path.join
    // normalizes `..` silently — a hostile runId like `../../etc/foo`
    // would resolve outside the intended runs root. The runner reuses
    // the same SAFE_VALUE_RE guard as --memory-key / CAMBIUM_SESSION_ID
    // (RED-215 phase 3). Auto-generated runIds trivially pass.
    await expect(
      runGen({
        ir: minimalIr('MockReport') as never,
        schemas: { MockReport },
        mock: true,
        runId: '../../etc/evil',
      } as RunGenOptions),
    ).rejects.toThrow(/runId/);
  });

  it('accepts a normal runId override (auto-generated shape)', async () => {
    // Belt-and-suspenders: confirm the validator doesn't reject the
    // auto-generated shape if a caller pins it explicitly.
    const result = await runGen({
      ir: minimalIr('MockReport') as never,
      schemas: { MockReport },
      mock: true,
      runId: 'run_20260507_120000_abcdef',
    } as RunGenOptions);
    expect(result.ok).toBe(true);
    expect(result.runId).toBe('run_20260507_120000_abcdef');
  });

  it('runs end-to-end with mock=true and returns a validated RunGenResult', async () => {
    const result = await runGen({
      ir: minimalIr('MockReport') as never,
      schemas: { MockReport },
      mock: true,
    } as RunGenOptions);

    expect(result.ok).toBe(true);
    expect(result.runId).toMatch(/^run_/);
    expect(result.schemaId).toBe('MockReport');
    expect(result.output).toMatchObject({ summary: expect.any(String) });
    expect(result.trace?.steps?.length).toBeGreaterThan(0);
    expect(result.errorMessage).toBeUndefined();
  });

  it('restores CAMBIUM_ALLOW_MOCK after the call (mock plumbing does not leak env state)', async () => {
    const before = process.env.CAMBIUM_ALLOW_MOCK;
    await runGen({
      ir: minimalIr('MockReport') as never,
      schemas: { MockReport },
      mock: true,
    } as RunGenOptions);
    expect(process.env.CAMBIUM_ALLOW_MOCK).toBe(before);
  });

  it('throws a clear error when the schema is missing from opts.schemas', async () => {
    await expect(runGen({
      ir: minimalIr('NotInSchemas') as never,
      schemas: { MockReport }, // no NotInSchemas
      mock: true,
    } as RunGenOptions)).rejects.toThrow(/Schema not found in injected schemas/);
  });
});
