/**
 * #250: `runGen` used to register a `process.once('exit', ...)` memory
 * cleanup handler unconditionally, before it knew whether the gen
 * declared any memory at all — and never released it. `cambium serve`
 * calls `runGenFromIr` once per HTTP request in a long-lived process
 * (packages/cambium-runner/src/serve/serve.ts), so listeners grew
 * without bound: Node emits `MaxListenersExceededWarning` from the
 * 11th request on.
 *
 * Drives `runGen` directly with a synthetic IR — same pattern as
 * cron-fire-id.test.ts — so the test needs no Ruby compiler and no
 * `better-sqlite3` native module. The gen below declares NO memory
 * (`ir.policies` has no `memory` key), which is deliberate: it's the
 * exact case that produced the 11-listener leak in CI, since the old
 * code registered the hook for every run regardless of memory use.
 *
 * Both halves of the fix are covered, and each fails independently:
 *
 *  - CONDITIONAL REGISTRATION ("don't register when the gen declares no
 *    memory") — the memory-less case below.
 *  - RELEASE (the `process.off('exit', ...)` calls in runner.ts) — the
 *    memory-declaring case below.
 *
 * The release case needs a gen that actually declares memory, which would
 * normally mean a real SQLite backend — an optional native dep this
 * project deliberately does not install in CI, so such a test would skip
 * exactly where it is needed. It doesn't have to: every memory function
 * `runGen` touches comes from the single `./memory/runner-integration.js`
 * module, so stubbing that module exercises the real registration and
 * release lines with no native dep in sight. What is faked is the SQLite
 * backend; the listener bookkeeping under test is the genuine article.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runGen } from './runner.js';

// Stub the memory module so a memory-DECLARING gen can run with no SQLite.
// `planMemory` must return a non-empty array: runner.ts guards the release
// site with `if (memoryPlans.length > 0)`, so an empty plan would skip the
// very lines under test and hand us a green test that proves nothing.
const closeBackendsMock = vi.fn();
vi.mock('./memory/runner-integration.js', () => ({
  planMemory: vi.fn(() => [{ name: 'notes', scope: 'session' }]),
  readMemoryForRun: vi.fn(async () => ({
    block: '',
    trace: [],
    backends: new Map([['notes', {}]]),
  })),
  commitMemoryWrites: vi.fn(async () => []),
  closeBackends: (...args: any[]) => closeBackendsMock(...args),
}));

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

describe('runGen — process "exit" listener leak (#250)', () => {
  beforeEach(() => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('does not accumulate an "exit" listener per call on a memory-less gen (the cambium serve pattern)', async () => {
    const before = process.listenerCount('exit');
    for (let i = 0; i < 15; i++) {
      const result = await runGen({ ir: baseIR(), schemas: { MockOutput: MockSchema } });
      expect(result.ok).toBe(true);
    }
    const after = process.listenerCount('exit');
    expect(after).toBe(before);
  });

  it('releases the "exit" listener it registers for a memory-declaring gen', async () => {
    closeBackendsMock.mockClear();
    const before = process.listenerCount('exit');

    for (let i = 0; i < 15; i++) {
      const ir: any = baseIR();
      ir.policies.memory = [{ name: 'notes', scope: 'session', strategy: 'sliding_window' }];
      await runGen({ ir, schemas: { MockOutput: MockSchema } });
    }

    // The registration path really did run — otherwise this case would be
    // a second, weaker copy of the memory-less one above.
    expect(closeBackendsMock).toHaveBeenCalled();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
