/**
 * #205: `--mock` output, schema-derived (deterministic, no randomness,
 * no clock, no environment — a pure function of (prompt, schema)).
 *
 * Precedence (DEC-002):
 *   1. Canned framework schema ids (`MemoryWrites`, `CambiumDiffAnalysis`,
 *      `CambiumCiReview`) — byte-identical fixed strings.
 *   2. No schema, or the default analyst payload validates against the
 *      schema (`defaultMockFits` — decided by the validator itself, with
 *      the Validate step's own configuration) — today's default payload,
 *      unchanged.
 *   3. Otherwise, derive a schema-valid payload by walking the schema
 *      (`deriveMockFromSchema`).
 *
 * This preserves every mock output that validated before this change —
 * the fit check is what the byte-identity promise rests on; don't loosen
 * it without re-checking the fifteen tests that pin the default payload.
 */

import Ajv from 'ajv';

// ── Canned framework schemas (moved verbatim from runner.ts) ──────────

// RED-215 phase 4: retro memory agents return MemoryWrites, not the
// analyst shape. Branch on the schema id so both primary gens and
// retro agents can run end-to-end under --mock. Any new mock-
// incompatible framework schema gets its own branch here.
//
// NOTE: MemoryWrites is a framework-internal return type for retro
// agents. A user-authored primary gen that uses `returns MemoryWrites`
// would also hit this branch under --mock and receive the canned
// write regardless of its input — don't use MemoryWrites as a primary
// output schema.
function cannedMemoryWrites(): string {
  // Emit one write against a conventional memory name. Primary gens
  // that declare `memory :conversation` will receive it; others will
  // have it dropped at apply-time with a traced "no matching decl"
  // reason. Both paths are exercised by integration tests.
  return JSON.stringify({
    writes: [{ memory: 'conversation', content: 'mock retro agent note' }],
  });
}

// RED-381 Cambium CI Review POC: framework-internal schemas with
// `additionalProperties: false` would otherwise reject the default
// mock payload at validation. Canned shape-valid responses keep the
// e2e test honest without a real LLM call.
function cannedDiffAnalysis(): string {
  return JSON.stringify({
    summary: 'Mock Cambium diff analysis: changes appear to touch the DSL surface.',
    touched_surfaces: ['ruby_dsl', 'docs'],
    risk_categories: ['new_dsl_primitive'],
    magnitude: 'small',
    files_changed: 2,
    key_excerpts: [],
  });
}

function cannedCiReview(): string {
  return JSON.stringify({
    summary: 'Mock review: changes look reasonable; verify the docs entry is in.',
    concerns: [
      {
        severity: 'suggestion',
        category: 'docs-drift',
        message: 'New DSL primitive — confirm CLAUDE.md "Key concepts" and a P-doc entry both land.',
      },
    ],
    overall_verdict: 'approve_with_suggestions',
  });
}

// ── Default payload (moved verbatim from runner.ts) ────────────────────

export function defaultMockPayload(prompt: string): string {
  const matches = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*ms\b/gi)].map(m => Number(m[1]));
  const payload = {
    summary: 'Mock analysis (model provider not available).',
    metrics: {
      latency_ms_samples: matches
    },
    key_facts: [] as any[]
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * DEC-002 (as amended by A-004 — AUD-002 / AUD-003): true when the default
 * analyst payload for `prompt` validates against `schema`, decided by the
 * validator itself with the same configuration the Validate step uses
 * (`Ajv({ allErrors: true, strict: false })`, no formats). "Fits" therefore
 * means exactly "Validate would pass on the default payload". The earlier
 * per-key type comparison was wrong in both directions: it said "fits"
 * for a `metrics` block with its own required properties (the default's
 * `{ latency_ms_samples }` then failed Validate) and "doesn't fit" for a
 * nullable `type: ['string', 'null']` summary (the default validated, and
 * byte-identity broke). Deciding by validation rather than by an id
 * allowlist is what keeps every existing test IR's outcome unchanged —
 * those schemas carry arbitrary `$id`s.
 *
 * A fresh Ajv instance per call: `$id` registration is per instance, and
 * this is a mock-only path where the compile cost is irrelevant next to
 * the model call it replaces. A schema Ajv cannot compile does not fit —
 * the derived branch runs, and the Validate step reports the schema
 * problem on its own terms.
 */
export function defaultMockFits(schema: any, prompt = ''): boolean {
  if (!schema) return true;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    return ajv.validate(schema, JSON.parse(defaultMockPayload(prompt))) === true;
  } catch {
    return false;
  }
}

// ── Schema-derived fallback (DEC-003) ──────────────────────────────────

function resolveRef(ref: string, root: any): any {
  const m = /^#\/(?:definitions|\$defs)\/([^/]+)$/.exec(ref);
  if (!m) return null;
  const key = m[1];
  return root?.definitions?.[key] ?? root?.$defs?.[key] ?? null;
}

// Two independent bounds keep the walk finite (A-005 — AUD-001):
//
//   - `refDepth` bounds the LENGTH of a `$ref` chain. It is scoped to
//     `$ref` traversal only — a legitimately deep, non-cyclic
//     nested-object schema must not trip it.
//   - `budget.nodes` bounds the TOTAL number of values constructed. A
//     depth bound alone is not enough: a cyclic `$ref` under an array with
//     `minItems: 2`, or under an object with two self-referencing
//     properties, multiplies per level (2^32 values at MAX_REF_DEPTH) and
//     never returns. Once the budget is spent, arrays and objects stop
//     adding members and every further value derives to `null`. The
//     output is then simply invalid and Validate fails deterministically —
//     the walker's stated contract for any schema it cannot satisfy. The
//     same bound clamps a flat `minItems: 100000` (the schema is the gen
//     author's own, but a mock should never be the slow part of a run).
//
// Both counters are fresh per `deriveMockFromSchema` call, so the function
// stays pure.
const MAX_REF_DEPTH = 32;
export const MAX_MOCK_NODES = 10_000;

type Budget = { nodes: number };

function deriveValue(schema: any, root: any, name: string | undefined, refDepth: number, budget: Budget): any {
  if (schema == null || typeof schema !== 'object') return null;
  if (budget.nodes >= MAX_MOCK_NODES) return null;
  budget.nodes += 1;

  if (typeof schema.$ref === 'string') {
    if (refDepth > MAX_REF_DEPTH) return null;
    const resolved = resolveRef(schema.$ref, root);
    if (resolved == null) return null;
    return deriveValue(resolved, root, name, refDepth + 1, budget);
  }

  // Value precedence: const → enum[0] → default → by type.
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return deriveValue(schema.anyOf[0], root, name, refDepth, budget);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return deriveValue(schema.oneOf[0], root, name, refDepth, budget);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    let merged: Record<string, any> = {};
    for (const branch of schema.allOf) {
      const value = deriveValue(branch, root, name, refDepth, budget);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        merged = { ...merged, ...value };
      }
    }
    return merged;
  }

  let type = schema.type;
  if (Array.isArray(type)) {
    type = type.find((t: string) => t !== 'null');
  }
  if (type === undefined && schema.properties) type = 'object';

  switch (type) {
    case 'string':
      return name ? `mock ${name}` : 'mock';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' && schema.minimum > 0 ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array': {
      const items = schema.items;
      if (!items || schema.maxItems === 0) return [];
      const count = typeof schema.minItems === 'number' ? Math.max(0, schema.minItems) : 1;
      const out: any[] = [];
      for (let i = 0; i < count && budget.nodes < MAX_MOCK_NODES; i++) {
        out.push(deriveValue(items, root, name, refDepth, budget));
      }
      return out;
    }
    case 'object': {
      const properties = schema.properties ?? {};
      const obj: Record<string, any> = {};
      for (const key of Object.keys(properties)) {
        if (budget.nodes >= MAX_MOCK_NODES) break;
        obj[key] = deriveValue(properties[key], root, key, refDepth, budget);
      }
      // A-001b: a `required` key with no entry in `properties` has no shape
      // to derive from. When the schema still allows undeclared properties
      // (`additionalProperties !== false`), a required key with no schema
      // accepts any value — `null` is as good as anything else. When
      // `additionalProperties === false`, the schema is unsatisfiable
      // (required demands the key; additionalProperties forbids adding one
      // with no declared shape) — synthesize nothing, so Validate fails as
      // it must.
      // AUD-005: these synthesized keys are values too — they draw on the
      // same budget, so a huge `required` list cannot grow the object
      // without bound.
      if (schema.additionalProperties !== false) {
        const required: string[] = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
          if (key in properties) continue;
          if (budget.nodes >= MAX_MOCK_NODES) break;
          budget.nodes += 1;
          obj[key] = null;
        }
      }
      return obj;
    }
    default:
      // Untyped, no hints (const/enum/default/anyOf/oneOf/allOf/properties
      // all absent) — nothing to derive.
      return null;
  }
}

/**
 * DEC-003: deterministic recursion over Draft-07, producing a best-effort
 * schema-valid payload. Covers the closed `returns do … end` vocabulary
 * and every hand-written TypeBox contract (which carry no constraint
 * keywords beyond type/required/properties). Deliberately does not
 * synthesize `pattern` / `minLength` / `multipleOf` / `format` — a schema
 * the walker can't satisfy still fails Validate deterministically.
 */
export function deriveMockFromSchema(schema: any): any {
  return deriveValue(schema, schema, undefined, 0, { nodes: 0 });
}

// ── Entry point ─────────────────────────────────────────────────────────

export function mockOutputText(prompt: string, schema?: { $id?: string }): string {
  if (schema?.$id === 'MemoryWrites') return cannedMemoryWrites();
  if (schema?.$id === 'CambiumDiffAnalysis') return cannedDiffAnalysis();
  if (schema?.$id === 'CambiumCiReview') return cannedCiReview();

  if (!schema || defaultMockFits(schema, prompt)) return defaultMockPayload(prompt);

  return JSON.stringify(deriveMockFromSchema(schema), null, 2);
}
