/**
 * #205 STEP-001: unit tests for the schema-derived mock text generator
 * (canned id → default-if-it-fits → schema-derived, DEC-002/DEC-003).
 *
 * The canned-string and default-payload cases pin BYTE-IDENTICAL output
 * to what `runner.ts#mockGenerate` produced before this change — the
 * literals here are copied straight from the pre-#205 switch.
 */
import { describe, it, expect } from 'vitest';
import { mockOutputText, defaultMockFits, deriveMockFromSchema, defaultMockPayload, MAX_MOCK_NODES } from './mock-output.js';
import Ajv from 'ajv';

describe('mockOutputText — canned framework schema ids (byte-identical)', () => {
  it('MemoryWrites', () => {
    const out = mockOutputText('anything', { $id: 'MemoryWrites' });
    expect(out).toBe(JSON.stringify({
      writes: [{ memory: 'conversation', content: 'mock retro agent note' }],
    }));
  });

  it('CambiumDiffAnalysis', () => {
    const out = mockOutputText('anything', { $id: 'CambiumDiffAnalysis' });
    expect(out).toBe(JSON.stringify({
      summary: 'Mock Cambium diff analysis: changes appear to touch the DSL surface.',
      touched_surfaces: ['ruby_dsl', 'docs'],
      risk_categories: ['new_dsl_primitive'],
      magnitude: 'small',
      files_changed: 2,
      key_excerpts: [],
    }));
  });

  it('CambiumCiReview', () => {
    const out = mockOutputText('anything', { $id: 'CambiumCiReview' });
    expect(out).toBe(JSON.stringify({
      summary: 'Mock review: changes look reasonable; verify the docs entry is in.',
      concerns: [
        {
          severity: 'suggestion',
          category: 'docs-drift',
          message: 'New DSL primitive — confirm CLAUDE.md "Key concepts" and a P-doc entry both land.',
        },
      ],
      overall_verdict: 'approve_with_suggestions',
    }));
  });
});

describe('mockOutputText — default payload (byte-identical, applies when it fits)', () => {
  function expectedDefault(prompt: string) {
    const matches = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*ms\b/gi)].map(m => Number(m[1]));
    return JSON.stringify({
      summary: 'Mock analysis (model provider not available).',
      metrics: { latency_ms_samples: matches },
      key_facts: [] as any[],
    }, null, 2);
  }

  it('no schema at all', () => {
    expect(mockOutputText('hello world')).toBe(expectedDefault('hello world'));
  });

  it('permissive {} schema', () => {
    expect(mockOutputText('hello world', {})).toBe(expectedDefault('hello world'));
  });

  it('permissive additionalProperties: true schema', () => {
    const schema = { type: 'object', additionalProperties: true };
    expect(mockOutputText('hello world', schema as any)).toBe(expectedDefault('hello world'));
  });

  it('required: [summary] with the three keys declared compatibly', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
      },
      required: ['summary'],
    };
    expect(mockOutputText('hello world', schema as any)).toBe(expectedDefault('hello world'));
  });

  it('mines latency_ms_samples from the prompt', () => {
    const prompt = 'request took 120ms and then 45.5 ms more';
    const out = mockOutputText(prompt);
    const parsed = JSON.parse(out);
    expect(parsed.metrics.latency_ms_samples).toEqual([120, 45.5]);
    expect(out).toBe(expectedDefault(prompt));
  });

  it('defaultMockPayload matches mockOutputText\'s default branch', () => {
    expect(defaultMockPayload('12ms')).toBe(expectedDefault('12ms'));
  });
});

describe('defaultMockFits / derivation — switches to derived exactly where default would fail', () => {
  it('a missing required key (not summary/metrics/key_facts) does not fit', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
        missing_required_field: { type: 'string' },
      },
      required: ['summary', 'missing_required_field'],
      additionalProperties: false,
    };
    expect(defaultMockFits(schema)).toBe(false);
    const out = mockOutputText('anything', schema as any);
    // The walker derives every DECLARED property (DEC-003) — a required
    // key that is only listed in `required`, never declared in
    // `properties`, cannot be synthesized (see the untyped-required-key
    // case below, which stays unsatisfiable by design).
    expect(JSON.parse(out)).toEqual({
      summary: 'mock summary',
      metrics: {},
      key_facts: [],
      missing_required_field: 'mock missing_required_field',
    });
  });

  it('a required key absent from properties entirely cannot be synthesized (schema stays unsatisfiable)', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
      },
      required: ['summary', 'undeclared_required_field'],
      additionalProperties: false,
    };
    expect(defaultMockFits(schema)).toBe(false);
    const out = mockOutputText('anything', schema as any);
    expect(JSON.parse(out)).toEqual({ summary: 'mock summary', metrics: {}, key_facts: [] });
    expect(JSON.parse(out)).not.toHaveProperty('undeclared_required_field');
  });

  it('additionalProperties: false without metrics does not fit', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        key_facts: { type: 'array' },
      },
      required: ['summary'],
      additionalProperties: false,
    };
    expect(defaultMockFits(schema)).toBe(false);
  });

  it('summary declared as integer does not fit', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'integer' },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
      },
      required: ['summary'],
    };
    expect(defaultMockFits(schema)).toBe(false);
    const out = mockOutputText('anything', schema as any);
    expect(JSON.parse(out).summary).toBe(0);
  });
});

describe('deriveMockFromSchema — the walker (DEC-003)', () => {
  it('names a string value after its property key', () => {
    expect(deriveMockFromSchema({
      type: 'object',
      properties: { title: { type: 'string' } },
    })).toEqual({ title: 'mock title' });
  });

  it('a nameless root string yields "mock"', () => {
    expect(deriveMockFromSchema({ type: 'string' })).toBe('mock');
  });

  it('enum wins over type default (first entry)', () => {
    expect(deriveMockFromSchema({ type: 'string', enum: ['dark', 'light'] })).toBe('dark');
  });

  it('const wins over enum', () => {
    expect(deriveMockFromSchema({ type: 'string', const: 'fixed', enum: ['a', 'b'] })).toBe('fixed');
  });

  it('default wins over type, when no const/enum', () => {
    expect(deriveMockFromSchema({ type: 'string', default: 'preset' })).toBe('preset');
  });

  it('integer/number default to 0', () => {
    expect(deriveMockFromSchema({ type: 'integer' })).toBe(0);
    expect(deriveMockFromSchema({ type: 'number' })).toBe(0);
  });

  it('integer/number use minimum when it is greater than 0', () => {
    expect(deriveMockFromSchema({ type: 'integer', minimum: 5 })).toBe(5);
    expect(deriveMockFromSchema({ type: 'integer', minimum: -5 })).toBe(0);
    expect(deriveMockFromSchema({ type: 'integer', minimum: 0 })).toBe(0);
  });

  it('boolean derives false', () => {
    expect(deriveMockFromSchema({ type: 'boolean' })).toBe(false);
  });

  it('array: minItems copies of the derived items (default 1)', () => {
    expect(deriveMockFromSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    })).toEqual({ tags: ['mock tags'] });

    expect(deriveMockFromSchema({ type: 'array', items: { type: 'string' }, minItems: 3 }))
      .toEqual(['mock', 'mock', 'mock']);
  });

  it('array: maxItems 0 forces an empty array even with minItems', () => {
    expect(deriveMockFromSchema({ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 0 }))
      .toEqual([]);
  });

  it('array: no items schema yields an empty array', () => {
    expect(deriveMockFromSchema({ type: 'array' })).toEqual([]);
  });

  it('nested object includes optional keys, not just required ones', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        score: { type: 'number' },
      },
      required: ['summary'],
    };
    expect(deriveMockFromSchema(schema)).toEqual({ summary: 'mock summary', score: 0 });
  });

  it('a schema with no properties derives an empty object', () => {
    expect(deriveMockFromSchema({ type: 'object' })).toEqual({});
  });

  // A-001b: a `required` key absent from `properties` has no shape to derive.
  it('a required key with no declared property gets null when additionalProperties allows it', () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary', 'undeclared'],
    };
    expect(deriveMockFromSchema(schema)).toEqual({ summary: 'mock summary', undeclared: null });
  });

  it('a required key with no declared property is omitted when additionalProperties is false (unsatisfiable, by design)', () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary', 'undeclared'],
      additionalProperties: false,
    };
    expect(deriveMockFromSchema(schema)).toEqual({ summary: 'mock summary' });
  });

  it('type given as an array picks the first non-null entry', () => {
    expect(deriveMockFromSchema({ type: ['null', 'string'] })).toBe('mock');
  });

  it('anyOf derives the first branch', () => {
    expect(deriveMockFromSchema({ anyOf: [{ type: 'string' }, { type: 'integer' }] })).toBe('mock');
  });

  it('oneOf derives the first branch', () => {
    expect(deriveMockFromSchema({ oneOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0);
  });

  it('allOf shallow-merges each branch in order', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    };
    expect(deriveMockFromSchema(schema)).toEqual({ a: 'mock a', b: 0 });
  });

  it('$ref resolves against #/definitions', () => {
    const schema = {
      definitions: { Widget: { type: 'string' } },
      type: 'object',
      properties: { widget: { $ref: '#/definitions/Widget' } },
    };
    expect(deriveMockFromSchema(schema)).toEqual({ widget: 'mock widget' });
  });

  it('$ref resolves against #/$defs', () => {
    const schema = {
      $defs: { Widget: { type: 'integer', minimum: 7 } },
      type: 'object',
      properties: { widget: { $ref: '#/$defs/Widget' } },
    };
    expect(deriveMockFromSchema(schema)).toEqual({ widget: 7 });
  });

  it('an unresolvable $ref derives null', () => {
    expect(deriveMockFromSchema({ $ref: '#/definitions/Missing' })).toBeNull();
  });

  it('a cyclic $ref chain bottoms out at null rather than recursing forever', () => {
    const schema: any = {
      definitions: {
        A: { $ref: '#/definitions/B' },
        B: { $ref: '#/definitions/A' },
      },
      $ref: '#/definitions/A',
    };
    expect(deriveMockFromSchema(schema)).toBeNull();
  });

  it('untyped schema with no hints derives null', () => {
    expect(deriveMockFromSchema({})).toBeNull();
  });
});

describe('determinism', () => {
  it('two calls with the same (prompt, schema) produce deep-equal output', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        highlights: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' } },
          },
        },
      },
      required: ['summary', 'highlights'],
    };
    const a = mockOutputText('some prompt', schema as any);
    const b = mockOutputText('some prompt', schema as any);
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
  });
});

// ── Audit round 1 (records/AUDIT-205-…): A-004 fit-by-validation, A-005 node budget ──

/** The Validate step's exact configuration (runner.ts). */
function validates(schema: any, text: string): boolean {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.validate(schema, JSON.parse(text)) === true;
}

/** Count every constructed value, so the budget claim is checked directly. */
function countNodes(v: any): number {
  if (Array.isArray(v)) return 1 + v.reduce((n: number, x: any) => n + countNodes(x), 0);
  if (v && typeof v === 'object') return 1 + Object.values(v).reduce((n: number, x: any) => n + countNodes(x), 0);
  return 1;
}

describe('A-004 (AUD-002/AUD-003): "fits" is decided by the validator, not a shape heuristic', () => {
  it('AUD-002: a metrics block with its own required properties does not fit — the walker derives it and the result validates', () => {
    // Reachable from the closed `returns do … end` vocabulary
    // (`field :metrics do field :duration_ms, Float end`).
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: {
          type: 'object',
          properties: { duration_ms: { type: 'number' } },
          required: ['duration_ms'],
          additionalProperties: false,
        },
        key_facts: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'metrics', 'key_facts'],
      additionalProperties: false,
    };
    expect(validates(schema, defaultMockPayload(''))).toBe(false); // the premise
    expect(defaultMockFits(schema)).toBe(false);
    const text = mockOutputText('', schema);
    expect(JSON.parse(text).metrics).toEqual({ duration_ms: 0 });
    expect(validates(schema, text)).toBe(true);
  });

  it('AUD-002: fit is prompt-aware — key_facts/latency minItems fit only when the default payload actually satisfies them', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metrics: {
          type: 'object',
          properties: { latency_ms_samples: { type: 'array', items: { type: 'number' }, minItems: 1 } },
          required: ['latency_ms_samples'],
        },
        key_facts: { type: 'array' },
      },
      required: ['summary', 'metrics', 'key_facts'],
    };
    // No samples in the prompt → the default's `latency_ms_samples: []` violates minItems → derived.
    expect(defaultMockFits(schema, 'no timings here')).toBe(false);
    const derived = JSON.parse(mockOutputText('no timings here', schema));
    expect(derived.metrics.latency_ms_samples).toEqual([0]);
    expect(validates(schema, JSON.stringify(derived))).toBe(true);
    // Samples present → the default validates → byte-identical default payload.
    expect(defaultMockFits(schema, 'took 12 ms')).toBe(true);
    expect(mockOutputText('took 12 ms', schema)).toBe(defaultMockPayload('took 12 ms'));
  });

  it('AUD-002: a constraint the walker does not synthesize (pattern) still fails Validate deterministically — fail-closed, not silently "fits"', () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string', pattern: '^[0-9]{4}$' } },
      required: ['summary'],
    };
    expect(defaultMockFits(schema)).toBe(false);
    const a = mockOutputText('', schema);
    const b = mockOutputText('', schema);
    expect(a).toBe(b);
    expect(validates(schema, a)).toBe(false);
  });

  it('AUD-003: a nullable type array on a default key fits — byte-identical default payload, as before #205', () => {
    const schema = {
      required: ['summary', 'metrics', 'key_facts'],
      properties: {
        summary: { type: ['string', 'null'] },
        metrics: { type: 'object' },
        key_facts: { type: 'array' },
      },
    };
    expect(validates(schema, defaultMockPayload('x'))).toBe(true); // the premise
    expect(defaultMockFits(schema, 'x')).toBe(true);
    expect(mockOutputText('x', schema)).toBe(defaultMockPayload('x'));
  });

  it('a schema Ajv cannot compile does not fit (derived branch, no throw)', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $ref: 12 as any };
    expect(() => defaultMockFits(schema)).not.toThrow();
    expect(() => mockOutputText('', schema)).not.toThrow();
  });
});

describe('A-005 (AUD-001): the walk is bounded by a node budget, not only by $ref depth', () => {
  const cyclicWithArray = (minItems: number) => ({
    definitions: {
      node: {
        type: 'object',
        properties: { children: { type: 'array', items: { $ref: '#/definitions/node' }, minItems } },
      },
    },
    $ref: '#/definitions/node',
  });

  it('AUD-001 repro: a cyclic $ref under an array with minItems: 2 terminates within the budget', () => {
    const out = deriveMockFromSchema(cyclicWithArray(2));
    expect(out && typeof out === 'object').toBe(true);
    expect(Array.isArray(out.children)).toBe(true);
    expect(countNodes(out)).toBeLessThanOrEqual(MAX_MOCK_NODES);
  });

  it('a cyclic $ref under two self-referencing properties (object fan-out, no arrays) terminates too', () => {
    const schema = {
      definitions: {
        node: { type: 'object', properties: { left: { $ref: '#/definitions/node' }, right: { $ref: '#/definitions/node' } } },
      },
      $ref: '#/definitions/node',
    };
    const out = deriveMockFromSchema(schema);
    expect(out && typeof out === 'object').toBe(true);
    expect(countNodes(out)).toBeLessThanOrEqual(MAX_MOCK_NODES);
  });

  it('a single-chain cycle (minItems: 1) is unchanged: bottoms out at the $ref depth, far below the budget', () => {
    const out = deriveMockFromSchema(cyclicWithArray(1));
    let depth = 0;
    for (let cur = out; cur && Array.isArray(cur.children) && cur.children.length === 1; cur = cur.children[0]) depth += 1;
    expect(depth).toBeGreaterThan(10);
    expect(countNodes(out)).toBeLessThan(MAX_MOCK_NODES);
  });

  it('a flat minItems: 100000 is clamped by the same budget (fails Validate deterministically instead of being the slow part of a run)', () => {
    const schema = { type: 'array', items: { type: 'string' }, minItems: 100_000 };
    const out = deriveMockFromSchema(schema);
    expect(out.length).toBeLessThan(MAX_MOCK_NODES);
    expect(out.length).toBeGreaterThan(1000);
    expect(validates(schema, JSON.stringify(out))).toBe(false);
  });

  it('AUD-005: required keys with no declared shape draw on the same budget (a huge required list is clamped)', () => {
    const required = Array.from({ length: 100_000 }, (_, i) => `k${i}`);
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required };
    const out = deriveMockFromSchema(schema);
    expect(out.a).toBe('mock a');
    const keys = Object.keys(out);
    expect(keys.length).toBeLessThanOrEqual(MAX_MOCK_NODES);
    expect(keys.length).toBeGreaterThan(1000);
    // Still valid-by-construction for the part it built: undeclared required keys are null.
    expect(out.k0).toBeNull();
  });

  it('the budget is per call — a spent budget does not leak into the next derivation', () => {
    deriveMockFromSchema(cyclicWithArray(2));
    expect(deriveMockFromSchema({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({ a: 'mock a' });
  });
});
