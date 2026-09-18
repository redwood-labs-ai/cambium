/**
 * #230 — OUTPUT_JSON_TEMPLATE's extra-keys clause agrees with the SCHEMA
 * block's judgment instead of asserting "no extra keys" unconditionally.
 *
 * Two hardcoded sites, one fix: `buildCacheablePrefix`'s OUTPUT_JSON_TEMPLATE
 * tail (feeds handleGenerate / handleAgenticGenerate / prewarmFanOut / the
 * five semantic repair sites) and `handleRepair`'s structural (no `source`)
 * repair prompt. Both now classify additionalProperties via the SAME
 * `additionalPropertiesState` helper `schemaPromptBlock`'s SCHEMA-block
 * closing uses — so the two blocks of one prompt can never contradict each
 * other again.
 *
 * The closed-schema cases are the HARD CONSTRAINT this ticket exists to
 * prove: today's in-tree norm (`additionalProperties: false` at every
 * level — every `contracts.ts` schema, every `returns do…end` block) must
 * see a byte-identical prompt, because prompt bytes ARE the prompt-cache
 * key (C-1/#228). Each closed-schema assertion below is copied verbatim
 * from the unconditional text both sites emitted on main before this fix.
 */
import { describe, it, expect } from 'vitest';
import { buildCacheablePrefix, handleRepair } from './step-handlers.js';
import { extractDocuments } from './documents.js';

const CLOSED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary'],
};

const OPEN_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary'],
};

const MIXED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    metadata: {
      type: 'object',
      additionalProperties: true,
      properties: { tag: { type: 'string' } },
    },
  },
  required: ['summary'],
};

// AUD-230-001: a properties-less "open map" — no `properties` key at all,
// so `collectAdditionalProperties` never visits it. Hand-written form.
const OPEN_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

// AUD-230-001: the same shape as TypeBox's `Type.Record(...)` actually
// compiles to — `patternProperties`, no `properties`, no explicit
// `additionalProperties` (defaults open per JSON Schema).
const RECORD_STYLE_SCHEMA = {
  type: 'object',
  patternProperties: { '^(.*)$': { type: 'string' } },
};

// AUD-230-003: the same properties-less open-map shape as AUD-230-001,
// but BURIED inside an otherwise-closed schema instead of at the root —
// `collectAdditionalProperties` never visited it at any depth, so the
// whole schema silently classified 'closed' instead of 'mixed'.
const NESTED_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    metadata: {
      type: 'object',
      patternProperties: { '^(.*)$': {} },
    },
  },
  required: ['summary'],
};

function makeIr(overrides: Record<string, any> = {}): any {
  return {
    model: { id: 'omlx:fake', max_tokens: 800 },
    system: 'You are an analyst.',
    policies: { grounding: { source: 'document' } },
    context: { document: 'DOC BODY' },
    ...overrides,
  };
}

describe('#230: OUTPUT_JSON_TEMPLATE agrees with the SCHEMA block on extra keys', () => {
  describe('site 1: buildCacheablePrefix (step-handlers.ts, the OUTPUT_JSON_TEMPLATE tail)', () => {
    it('closed schema: byte-identical to main (HARD CONSTRAINT)', async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, CLOSED_SCHEMA, docInput);

      // Verbatim from main pre-#230: unconditional "no extra keys".
      expect(cacheablePrefix).toBe(
        [
          'DOCUMENT:',
          'DOC BODY',
          '',
          'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; no extra keys):',
          '{"summary":"","tags":[]}',
        ].join('\n'),
      );
    });

    it('open schema: drops the contradictory "no extra keys" and says extras are allowed', async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, OPEN_SCHEMA, docInput);

      expect(cacheablePrefix).not.toContain('no extra keys');
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; extra keys are allowed):',
      );
    });

    it("mixed schema: enumerates the open path, matching schemaPromptBlock's taxonomy", async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, MIXED_SCHEMA, docInput);

      expect(cacheablePrefix).not.toContain('no extra keys');
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; extra keys allowed at: /metadata only):',
      );
    });

    it('AUD-230-001: properties-less open map does not falsely claim "no extra keys"', async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, OPEN_MAP_SCHEMA, docInput);

      expect(cacheablePrefix).not.toContain('no extra keys');
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; extra keys are allowed):',
      );
    });

    it('AUD-230-001: Type.Record-style (patternProperties, no `properties`) does not falsely claim "no extra keys"', async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, RECORD_STYLE_SCHEMA, docInput);

      expect(cacheablePrefix).not.toContain('no extra keys');
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; extra keys are allowed):',
      );
    });

    it('AUD-230-003: a nested Type.Record buried inside an otherwise-closed schema names the open path instead of claiming "no extra keys"', async () => {
      const ir = makeIr();
      const docInput = await extractDocuments(ir);
      const { cacheablePrefix } = buildCacheablePrefix(ir, NESTED_RECORD_SCHEMA, docInput);

      expect(cacheablePrefix).not.toContain('no extra keys');
      expect(cacheablePrefix).toContain(
        'OUTPUT_JSON_TEMPLATE (fill this; keep keys the same; extra keys allowed at: /metadata only):',
      );
    });
  });

  describe('site 2: handleRepair structural (ungrounded) repair prompt', () => {
    async function repairPromptFor(schema: any): Promise<string> {
      let captured: any;
      await handleRepair(
        '{"summary":"x"}',
        [{ message: 'boom' }],
        schema,
        { model: { id: 'omlx:fake', max_tokens: 400 } },
        1,
        async (opts: any) => {
          captured = opts;
          return { text: '{"summary":"y"}' };
        },
        JSON.parse,
      );
      return captured.prompt as string;
    }

    it('closed schema: byte-identical to main (HARD CONSTRAINT)', async () => {
      const prompt = await repairPromptFor(CLOSED_SCHEMA);
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; no extra keys):',
      );
    });

    it('open schema: drops the contradictory "no extra keys"', async () => {
      const prompt = await repairPromptFor(OPEN_SCHEMA);
      expect(prompt).not.toContain('no extra keys');
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; extra keys are allowed):',
      );
    });

    it("mixed schema: enumerates the open path, matching schemaPromptBlock's taxonomy", async () => {
      const prompt = await repairPromptFor(MIXED_SCHEMA);
      expect(prompt).not.toContain('no extra keys');
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; extra keys allowed at: /metadata only):',
      );
    });

    it('AUD-230-001: properties-less open map does not falsely claim "no extra keys"', async () => {
      const prompt = await repairPromptFor(OPEN_MAP_SCHEMA);
      expect(prompt).not.toContain('no extra keys');
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; extra keys are allowed):',
      );
    });

    it('AUD-230-001: Type.Record-style (patternProperties, no `properties`) does not falsely claim "no extra keys"', async () => {
      const prompt = await repairPromptFor(RECORD_STYLE_SCHEMA);
      expect(prompt).not.toContain('no extra keys');
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; extra keys are allowed):',
      );
    });

    it('AUD-230-003: a nested Type.Record buried inside an otherwise-closed schema names the open path instead of claiming "no extra keys"', async () => {
      const prompt = await repairPromptFor(NESTED_RECORD_SCHEMA);
      expect(prompt).not.toContain('no extra keys');
      expect(prompt).toContain(
        'OUTPUT_JSON_TEMPLATE (return this shape; keep keys the same; extra keys allowed at: /metadata only):',
      );
    });
  });
});
