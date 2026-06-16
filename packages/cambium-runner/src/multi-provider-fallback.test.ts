/**
 * RED-421: Multi-provider fallback — compiler + runner integration tests.
 *
 * Compiler tests (Ruby spawn):
 *   - single-arg `model` IR is byte-identical to pre-RED-421 (no `fallbacks` key)
 *   - multi-arg `model` emits `model.fallbacks` array
 *   - each fallback id is alias-resolved at compile time
 *
 * Runner unit tests:
 *   - `isTransientProviderError` (the REAL exported function, not an inline
 *     copy): ProviderHttpError 5xx/429/408/425 → transient; other 4xx →
 *     deterministic; untyped (plain Error / TypeError) → deterministic (DEC-A).
 *   - no fallbacks declared → behaves exactly as before (no `ModelFallback` steps)
 *   - mock path short-circuits fallback (CAMBIUM_ALLOW_MOCK=1)
 *
 * Runner integration tests (via `_testProviders` injection hook):
 *   - transient primary failure → fallback succeeds → `ModelFallback` step in trace
 *   - deterministic primary failure (4xx) → NO fallback, run fails fast
 *   - untyped primary failure → NO fallback (DEC-A)
 *   - ordered chain honored: primary → fallback[0] → fallback[1]
 *   - document gate fires BEFORE the `--mock` short-circuit (DEC-B / AUD-421-3)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGen, isTransientProviderError } from './runner.js';
import { ProviderHttpError, ProviderConnectionError } from './providers/types.js';
import type { CambiumProvider } from './providers/types.js';
import { openaiCompatible } from './providers/factories.js';
import { validateProviderBaseUrl, _resetValidatorCacheForTesting } from './providers/base-url-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPILE_RB = resolve(__dirname, '../../..', 'ruby/cambium/compile.rb');

// ── Compiler integration tests ────────────────────────────────────────────

const CONTRACTS = `
export const Anything = { $id: 'Anything', type: 'object', additionalProperties: true };
`;

function makeGen(modelLine: string): string {
  return `
class FallbackGen < GenModel
  ${modelLine}
  returns Anything

  def analyze(input)
    generate "analyze it"
  end
end
`;
}

describe('RED-421 DSL/compiler — model varargs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-red421-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src/contracts.ts'), CONTRACTS);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runCompile(genContent: string): { status: number; ir: any; stderr: string } {
    const genPath = join(tmp, 'app/gens/g.cmb.rb');
    writeFileSync(genPath, genContent);
    const result = spawnSync('ruby', [COMPILE_RB, genPath, '--method', 'analyze'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      status: result.status ?? -1,
      ir: result.status === 0 ? JSON.parse(result.stdout) : null,
      stderr: result.stderr ?? '',
    };
  }

  it('single-arg model compiles byte-identically — no fallbacks key', () => {
    // The IR must be byte-identical to pre-RED-421: `fallbacks` key MUST NOT appear.
    const { status, ir, stderr } = runCompile(makeGen('model "ollama:test"'));
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(ir.model.id).toBe('ollama:test');
    expect('fallbacks' in ir.model).toBe(false);
  });

  it('two-arg model emits primary id and fallbacks array', () => {
    const { status, ir, stderr } = runCompile(
      makeGen('model "anthropic:claude-opus", "omlx:backup-model"'),
    );
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(ir.model.id).toBe('anthropic:claude-opus');
    expect(ir.model.fallbacks).toEqual(['omlx:backup-model']);
  });

  it('three-arg model emits primary + two fallbacks in declaration order', () => {
    const { status, ir, stderr } = runCompile(
      makeGen('model "anthropic:claude-opus", "omlx:backup", "ollama:last-resort"'),
    );
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(ir.model.id).toBe('anthropic:claude-opus');
    expect(ir.model.fallbacks).toEqual(['omlx:backup', 'ollama:last-resort']);
  });

  it('fallback ids resolve through model aliases at compile time', () => {
    // Create a models.rb that maps :backup to a literal.
    mkdirSync(join(tmp, 'app/config'), { recursive: true });
    writeFileSync(
      join(tmp, 'app/config/models.rb'),
      'backup "omlx:resolved-backup"\n',
    );
    const { status, ir, stderr } = runCompile(
      makeGen('model "anthropic:claude-opus", :backup'),
    );
    expect(status, `stderr: ${stderr}`).toBe(0);
    expect(ir.model.id).toBe('anthropic:claude-opus');
    // The alias :backup resolves at compile time — the IR sees the literal.
    expect(ir.model.fallbacks).toEqual(['omlx:resolved-backup']);
  });

  it('unknown fallback alias raises CompileError at compile time', () => {
    const { status, stderr } = runCompile(
      makeGen('model "anthropic:claude-opus", :no_such_alias'),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown model alias :no_such_alias/);
  });
});

// ── Runner unit tests ─────────────────────────────────────────────────────

/** Minimal valid IR for a single-step gen. `returnSchema` is inline so no
 *  contracts module is needed. */
function makeIR(modelId: string, fallbacks?: string[]): any {
  return {
    version: '0.2',
    entry: { class: 'FallbackGen', method: 'analyze', source: 'g.cmb.rb' },
    model: {
      id: modelId,
      temperature: 0.1,
      max_tokens: 100,
      ...(fallbacks ? { fallbacks } : {}),
    },
    system: 'test system',
    mode: 'single',
    policies: { tools_allowed: [], correctors: [], constraints: {}, grounding: null },
    returnSchema: {
      $id: 'FallbackOutput',
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    context: { document: 'test document' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{ id: 'gen_1', type: 'Generate', prompt: 'analyze this' }],
  };
}

/** Schemas placeholder — not needed when returnSchema is inline. */
const SCHEMAS = {};

// The mock generator (runner.ts:mockGenerate) emits { summary, metrics, key_facts }.
// Our inline schema requires summary and allows the other two, so it validates fine.

// A fake provider whose generateText/generateWithTools behavior is supplied
// by the test. Injected via runGen's `_testProviders` hook so the fallback
// loop is exercised for real (no live network). `name` is overwritten to the
// map key by runGen, so it's a placeholder here.
function fakeProvider(
  handlers: Partial<Pick<CambiumProvider, 'generateText' | 'generateWithTools'>>,
): CambiumProvider {
  return {
    name: 'fake',
    supportsDocuments: false,
    async generateText() {
      throw new Error('fakeProvider: generateText not configured');
    },
    async generateWithTools() {
      throw new Error('fakeProvider: generateWithTools not configured');
    },
    ...handlers,
  };
}

/** A fake provider that always succeeds, returning a schema-valid payload. */
function succeedingProvider(summary: string): CambiumProvider {
  return fakeProvider({
    async generateText() {
      return { text: JSON.stringify({ summary, metrics: {}, key_facts: [] }) };
    },
  });
}

/** A fake provider that always throws the given error. */
function throwingProvider(makeErr: () => Error): CambiumProvider {
  return fakeProvider({
    async generateText() {
      throw makeErr();
    },
  });
}

describe('RED-421 runner — mock short-circuit', () => {
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('no fallbacks: behaves exactly as before (no ModelFallback steps)', async () => {
    // With CAMBIUM_ALLOW_MOCK the mock provider succeeds immediately.
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({ ir: makeIR('omlx:primary'), schemas: SCHEMAS });
    expect(result.ok).toBe(true);
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    expect(fallbackSteps).toHaveLength(0);
  });

  it('mock short-circuits fallback: no ModelFallback steps even with fallbacks declared', async () => {
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    const result = await runGen({
      ir: makeIR('omlx:primary', ['omlx:fallback']),
      schemas: SCHEMAS,
    });
    expect(result.ok).toBe(true);
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    // Mock path runs before any provider dispatch → no fallback emitted.
    expect(fallbackSteps).toHaveLength(0);
  });
});

// ── Real ordered-failover integration tests (AUD-421-2) ───────────────────
// These drive the actual fallback loop in makeGenerateText via the
// `_testProviders` injection hook — no live network, no inline reimplementation.
describe('RED-421 runner — ordered failover (real loop)', () => {
  it('transient primary failure → fallback success → ModelFallback step in trace', async () => {
    const result = await runGen({
      ir: makeIR('fakeprimary:m1', ['fakefallback:m2']),
      schemas: SCHEMAS,
      _testProviders: new Map([
        ['fakeprimary', throwingProvider(() => new ProviderHttpError(503, 'fakeprimary error: HTTP 503'))],
        ['fakefallback', succeedingProvider('from-fallback')],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.output.summary).toBe('from-fallback');
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    expect(fallbackSteps).toHaveLength(1);
    expect(fallbackSteps[0].meta.error_class).toBe('transient');
    expect(fallbackSteps[0].meta.attempted).toBe('fakeprimary:m1');
    expect(fallbackSteps[0].meta.fallback_to).toBe('fakefallback:m2');
  });

  it('deterministic primary failure (4xx) → NO fallback, run fails fast', async () => {
    // 400 is deterministic — the loop must NOT walk to the fallback (which
    // would have succeeded). The run rejects (runGen re-throws non-budget
    // errors out of the dispatch path).
    const fallback = succeedingProvider('should-not-be-reached');
    let fallbackCalled = false;
    const watchedFallback: CambiumProvider = {
      ...fallback,
      async generateText(opts) {
        fallbackCalled = true;
        return fallback.generateText(opts);
      },
    };
    await expect(
      runGen({
        ir: makeIR('fakeprimary:m1', ['fakefallback:m2']),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fakeprimary', throwingProvider(() => new ProviderHttpError(400, 'fakeprimary error: HTTP 400'))],
          ['fakefallback', watchedFallback],
        ]),
      }),
    ).rejects.toThrow(/HTTP 400/);
    expect(fallbackCalled).toBe(false);
  });

  it('untyped primary failure (plain Error) → NO fallback (DEC-A)', async () => {
    // A custom provider that throws a plain Error is deterministic by DEC-A:
    // no fan-out to the fallback.
    let fallbackCalled = false;
    const watchedFallback: CambiumProvider = {
      ...succeedingProvider('should-not-be-reached'),
      async generateText() {
        fallbackCalled = true;
        return { text: JSON.stringify({ summary: 'x', metrics: {}, key_facts: [] }) };
      },
    };
    await expect(
      runGen({
        ir: makeIR('fakeprimary:m1', ['fakefallback:m2']),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fakeprimary', throwingProvider(() => new Error('connection refused'))],
          ['fakefallback', watchedFallback],
        ]),
      }),
    ).rejects.toThrow(/connection refused/);
    expect(fallbackCalled).toBe(false);
  });

  it('ordered chain honored: primary → fallback[0] (transient) → fallback[1] success', async () => {
    const order: string[] = [];
    const result = await runGen({
      ir: makeIR('p0:m', ['p1:m', 'p2:m']),
      schemas: SCHEMAS,
      _testProviders: new Map<string, CambiumProvider>([
        ['p0', fakeProvider({
          async generateText() { order.push('p0'); throw new ProviderHttpError(503, 'p0 HTTP 503'); },
        })],
        ['p1', fakeProvider({
          async generateText() { order.push('p1'); throw new ProviderHttpError(429, 'p1 HTTP 429'); },
        })],
        ['p2', fakeProvider({
          async generateText() {
            order.push('p2');
            return { text: JSON.stringify({ summary: 'third', metrics: {}, key_facts: [] }) };
          },
        })],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.output.summary).toBe('third');
    // Tried in declaration order.
    expect(order).toEqual(['p0', 'p1', 'p2']);
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    // One step per fallback taken (p0→p1, p1→p2).
    expect(fallbackSteps).toHaveLength(2);
    expect(fallbackSteps[0].meta.fallback_to).toBe('p1:m');
    expect(fallbackSteps[1].meta.fallback_to).toBe('p2:m');
  });
});

// ── Document-gate ordering (DEC-B / AUD-421-3) ────────────────────────────
describe('RED-421 runner — document gate before mock (DEC-B)', () => {
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
  });

  it('document gate fires BEFORE the --mock short-circuit', async () => {
    // A base64_image document on a primary provider that does not support
    // documents. Pre-fix, --mock short-circuited first and the run resolved
    // ok:true (the regression). Post-fix, the primary document gate runs
    // first and throws — which runGen re-throws out of the dispatch path.
    // (base64_image, not base64_pdf, so no pdfjs-dist extraction is needed.)
    const ir = makeIR('omlx:primary');
    ir.context = {
      doc: { kind: 'base64_image', data: 'AAAA', media_type: 'image/png' },
    };
    process.env.CAMBIUM_ALLOW_MOCK = '1';
    await expect(runGen({ ir, schemas: SCHEMAS })).rejects.toThrow(
      /does not support native document input/,
    );
  });
});

// ── REAL isTransientProviderError classification (AUD-421-2) ───────────────
// Tests the EXPORTED function directly — no inline reimplementation.
describe('RED-421 isTransientProviderError classification (real export)', () => {
  it('transient ProviderHttpError statuses → true', () => {
    expect(isTransientProviderError(new ProviderHttpError(429, 'rate limited'))).toBe(true);
    expect(isTransientProviderError(new ProviderHttpError(503, 'unavailable'))).toBe(true);
    expect(isTransientProviderError(new ProviderHttpError(408, 'request timeout'))).toBe(true); // DEC-C
    expect(isTransientProviderError(new ProviderHttpError(425, 'too early'))).toBe(true); // DEC-C
  });

  it('deterministic ProviderHttpError statuses → false', () => {
    expect(isTransientProviderError(new ProviderHttpError(400, 'bad request'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(401, 'unauthorized'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(403, 'forbidden'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(404, 'not found'))).toBe(false);
    expect(isTransientProviderError(new ProviderHttpError(422, 'unprocessable'))).toBe(false);
  });

  it('untyped errors → false (DEC-A: deterministic, no fan-out)', () => {
    // A custom provider that throws a plain Error / TypeError is deterministic.
    // This is the critical DEC-A sub-decision: untyped errors do NOT fan out.
    expect(isTransientProviderError(new Error('connection refused'))).toBe(false);
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(false);
    // Even a plain Error whose message LOOKS like an HTTP error is deterministic —
    // the classifier keys on the TYPE, not the string (the AUD-421-1 fix).
    expect(isTransientProviderError(new Error('oMLX error: HTTP 503'))).toBe(false);
    expect(isTransientProviderError('a bare string')).toBe(false);
    expect(isTransientProviderError(undefined)).toBe(false);
  });

  it('ProviderHttpError 500–599 are all transient', () => {
    for (let s = 500; s <= 599; s++) {
      expect(isTransientProviderError(new ProviderHttpError(s, `HTTP ${s}`)), `HTTP ${s}`).toBe(true);
    }
  });

  it('ProviderHttpError 4xx except 408/425/429 are all deterministic', () => {
    for (let s = 400; s <= 499; s++) {
      const expected = s === 408 || s === 425 || s === 429;
      expect(isTransientProviderError(new ProviderHttpError(s, `HTTP ${s}`)), `HTTP ${s}`).toBe(expected);
    }
  });
});

// ── AUD-D1: SSRF/scheme guard throw is deterministic — NO failover (AUD-D1) ─
// Pins the fix: the base-URL SSRF guard's throw must propagate as a
// deterministic plain Error, not be re-wrapped as ProviderConnectionError.
// A blocked base URL on the primary must reject the run immediately;
// the fallback provider must never be called.
describe('RED-421 AUD-D1 — SSRF/scheme guard rejection is deterministic, no failover', () => {
  afterEach(() => {
    _resetValidatorCacheForTesting();
  });

  it('provider with blocked base URL (private-IP SSRF) → deterministic reject, fallback never called', async () => {
    // Build a real openaiCompatible factory whose baseUrl() callback runs the
    // SSRF guard with a private/metadata-range IP. After AUD-D1 fix, url() is
    // hoisted out of the try block, so the guard's plain Error propagates to
    // the fallback loop, which classifies it deterministic (not ProviderHttpError
    // → not ProviderConnectionError) → NO fan-out.
    const blockedProvider = openaiCompatible({
      name: 'blocked',
      baseUrl: () => {
        // 169.254.169.254 is the AWS/GCP/Azure metadata IP — blocked by default.
        // validateProviderBaseUrl is wired inside the baseUrl callback by the
        // built-in providers; we mirror that pattern here to exercise the
        // same code path that omlx/anthropic use.
        validateProviderBaseUrl('blocked (test)', 'https://169.254.169.254');
        return 'https://169.254.169.254';
      },
    });

    let fallbackCalled = false;
    const watchedFallback: CambiumProvider = {
      ...succeedingProvider('should-not-be-reached'),
      async generateText() {
        fallbackCalled = true;
        return { text: JSON.stringify({ summary: 'x', metrics: {}, key_facts: [] }) };
      },
    };

    await expect(
      runGen({
        ir: makeIR('blocked:m', ['fallbackb:m']),
        schemas: SCHEMAS,
        _testProviders: new Map<string, CambiumProvider>([
          ['blocked', blockedProvider],
          ['fallbackb', watchedFallback],
        ]),
      }),
    ).rejects.toThrow(/private\/metadata IP range/);

    // The fallback must never have been called — the rejection is deterministic.
    expect(fallbackCalled, 'fallback must not be called on SSRF guard rejection').toBe(false);
  });
});

// ── DEC-D: ProviderConnectionError + built-in connection failover ──────────
describe('RED-421 DEC-D — ProviderConnectionError and built-in connection failover', () => {
  // (a) Built-in connection failure on primary → FAILS OVER to fallback.
  // A ProviderConnectionError (status 0) is transient — the regression fixed.
  it('(a) ProviderConnectionError on primary → failover to fallback (AUD-F1 regression)', async () => {
    const result = await runGen({
      ir: makeIR('fakeprimary:m1', ['fakefallback:m2']),
      schemas: SCHEMAS,
      _testProviders: new Map([
        // Simulate a built-in provider throwing ProviderConnectionError (what the
        // factory's try/catch now produces on ECONNREFUSED/DNS/TLS failures).
        ['fakeprimary', throwingProvider(
          () => new ProviderConnectionError('fakeprimary connection failed: fetch failed'),
        )],
        ['fakefallback', succeedingProvider('from-fallback-after-connection-error')],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.output.summary).toBe('from-fallback-after-connection-error');
    const fallbackSteps = result.trace.steps.filter((s: any) => s.type === 'ModelFallback');
    expect(fallbackSteps).toHaveLength(1);
    expect(fallbackSteps[0].meta.error_class).toBe('transient');
    expect(fallbackSteps[0].meta.fallback_to).toBe('fakefallback:m2');
  });

  // (b) Custom/untyped plain Error → STILL fails fast, NO fallback (DEC-A preserved).
  it('(b) custom provider plain Error → still fails fast, no fallback (DEC-A preserved)', async () => {
    let fallbackCalled = false;
    const watchedFallback: CambiumProvider = {
      ...succeedingProvider('should-not-be-reached'),
      async generateText() {
        fallbackCalled = true;
        return { text: JSON.stringify({ summary: 'x', metrics: {}, key_facts: [] }) };
      },
    };
    await expect(
      runGen({
        ir: makeIR('fakeprimary:m1', ['fakefallback:m2']),
        schemas: SCHEMAS,
        _testProviders: new Map([
          // A custom provider throwing plain Error: deterministic, no fan-out.
          ['fakeprimary', throwingProvider(() => new Error('some custom error'))],
          ['fakefallback', watchedFallback],
        ]),
      }),
    ).rejects.toThrow(/some custom error/);
    expect(fallbackCalled).toBe(false);
  });

  // (c) ProviderConnectionError (status 0) is transient via isTransientProviderError.
  //     4xx deterministic / 5xx+429+408+425 transient already verified in the
  //     classification suite above; add the status-0 sentinel here explicitly.
  it('(c) ProviderConnectionError → classified transient (status 0 sentinel)', () => {
    const connErr = new ProviderConnectionError('fetch failed');
    expect(connErr).toBeInstanceOf(ProviderHttpError); // prototype chain
    expect(connErr.status).toBe(0);
    expect(connErr.name).toBe('ProviderConnectionError');
    expect(isTransientProviderError(connErr)).toBe(true);
    // Plain TypeError is still deterministic (DEC-A fan-out protection intact).
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(false);
  });

  // (d) AUD-F2: typed error survives the terminal re-wrap via `cause`.
  it('(d) terminal error re-wrap preserves typed cause (AUD-F2)', async () => {
    // Deterministic 400 — exhausts the chain; the runner wraps the error with
    // a hint string. The original ProviderHttpError must be reachable via .cause.
    let caughtError: Error | undefined;
    await expect(
      runGen({
        ir: makeIR('fakeprimary:m1'),
        schemas: SCHEMAS,
        _testProviders: new Map([
          ['fakeprimary', throwingProvider(() => new ProviderHttpError(400, 'fakeprimary error: HTTP 400'))],
        ]),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err as Error;
      return err instanceof Error;
    });
    // The outer error is a plain Error (the hint wrapper).
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).not.toBeInstanceOf(ProviderHttpError);
    // The cause is the original typed error with the status intact.
    const cause = (caughtError as any).cause;
    expect(cause).toBeInstanceOf(ProviderHttpError);
    expect((cause as ProviderHttpError).status).toBe(400);
  });
});
