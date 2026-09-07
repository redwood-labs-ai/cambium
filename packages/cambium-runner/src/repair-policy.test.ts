import { describe, it, expect } from 'vitest';
import { handleRepair } from './step-handlers.js';

const schema = {
  $id: 'GaiaAnswer',
  type: 'object',
  additionalProperties: false,
  properties: { reasoning: { type: 'string' }, answer: { type: 'string' } },
  required: ['reasoning', 'answer'],
};

// The structural sites hand `handleRepair` the runner's own JSON slicer
// (runner.ts#extractJsonObject). Mirrored so the assertions below cover what
// handleRepair receives in production.
function extractJsonObject(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

describe('repair policy', () => {
  it('fails closed (empty JSON) when raw is tool-call markup', async () => {
    const raw = '<|tool_call>call:web_search{query:<|"|>x<|"|>}<tool_call|>';

    const ir: any = { model: { id: 'omlx:fake', temperature: 0, max_tokens: 100 } };

    const res = await handleRepair(
      raw,
      [{ message: 'No data to validate' }],
      schema,
      ir,
      1,
      async () => {
        throw new Error('should not call model');
      },
      JSON.parse,
    );

    expect(res.parsed).toEqual({ reasoning: '', answer: '' });
    expect(JSON.parse(res.raw)).toEqual({ reasoning: '', answer: '' });
    expect(res.result.meta?.deterministic).toBe(true);
    expect(res.result.meta?.reason).toBe('tool_call_markup');
  });

  // RED-176: repair on its own model. Three things have to travel together or
  // the swap is a silent wrong-answer: which model ran, which ceiling the
  // trace blames, and which model the operator-facing error tells them to
  // retune. Absent a repair slot, every one of those stays the gen's.
  it('runs repair on the repair slot, and on the gen model when there is none', async () => {
    const ir: any = {
      model: { id: 'omlx:big', temperature: 0.2, max_tokens: 1200, fallbacks: ['ollama:mid'] },
      effort: 'high',
      repairModel: { id: 'omlx:nano', max_tokens: 400 },
    };
    const calls: any[] = [];

    const res = await handleRepair(
      '{"reasoning":"x"}',
      [{ message: "must have required property 'answer'", instancePath: '' }],
      schema,
      ir,
      1,
      async (opts: any) => {
        calls.push(opts);
        return { text: '{"reasoning":"x","answer":"y"}', usage: { completion_tokens: 40 } };
      },
      JSON.parse,
      ir.repairModel,
    );

    expect(calls[0].model).toBe('omlx:nano');
    // Floor: repair re-emits the whole document, so the slot's 400 is not the
    // ceiling — the gen's 1200 is. Repair never gets less room than generate had.
    expect(calls[0].max_tokens).toBe(1200);
    expect(calls[0].temperature).toBeUndefined();
    expect(calls[0].effort).toBeUndefined();
    expect(calls[0].fallbacks).toBeUndefined();
    expect(res.parsed).toEqual({ reasoning: 'x', answer: 'y' });
    expect(res.result.meta?.model_used).toBe('omlx:nano');

    const inherited: any[] = [];
    await handleRepair(
      '{"reasoning":"x"}',
      [{ message: 'boom' }],
      schema,
      { model: ir.model, effort: 'high' },
      1,
      async (opts: any) => {
        inherited.push(opts);
        return { text: '{"reasoning":"a","answer":"b"}' };
      },
      JSON.parse,
    );
    expect(inherited[0].model).toBe('omlx:big');
    expect(inherited[0].max_tokens).toBe(1200);
    expect(inherited[0].effort).toBe('high');
    expect(inherited[0].fallbacks).toEqual(['ollama:mid']);
  });

  it('names the repair model and its ceiling when repair runs out of room', async () => {
    const ir: any = {
      model: { id: 'omlx:big', temperature: 0.2, max_tokens: 1200 },
      repairModel: { id: 'omlx:nano', max_tokens: 300 },
    };

    const res = await handleRepair(
      '{"reasoning":"x"}',
      [{ message: 'boom' }],
      schema,
      ir,
      1,
      async () => ({
        text: '{"reasoning":"trunc',
        usage: { completion_tokens: 300 },
        stopReason: 'length',
      }),
      JSON.parse,
      ir.repairModel,
    );

    expect(res.parsed).toBeUndefined();
    expect(res.result.ok).toBe(false);
    // The floor puts the gen's 1200 in force even though repair declared 300 —
    // but the model that hit it is the repair model, and the message says so.
    expect(res.result.meta?.output_ceiling?.ceiling).toBe(1200);
    expect(res.result.meta?.max_tokens).toBe(1200);
    expect(res.result.errors?.[0]?.message).toMatch(/Output ceiling reached: omlx:nano/
    );
    expect(res.result.errors?.[0]?.message).toMatch(/Limit is 1200 tokens, from the gen's declared `max_tokens`/);
    expect(res.result.errors?.[0]?.message).toMatch(/Raise `max_tokens` on the gen/);
  });

  // End-to-end proof for the primitive: the model that FIXES the output is not
  // the model that WROTE it, the ceiling in force is the gen's, and the repair
  // still lands a schema-valid document. Without the floor the same call would
  // hand a 4B model less room than the frontier model had (RED-174's finding).
  it('structural repair runs on the repair slot, floored at the gen ceiling', async () => {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true });
    const schema: any = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: {
        answer: { type: 'string', minLength: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sources: { type: 'array', items: { type: 'string' } },
      },
    };
    const validateFn = ajv.compile(schema);

    const ir: any = {
      model: { id: 'gen', temperature: 0.2, max_tokens: 1200 },
      repairModel: { id: 'omlx:nano', max_tokens: 900, temperature: 0 },
    };
    const calls: any[] = [];
    const gen = async (o: any): Promise<any> => {
      calls.push(o);
      return { text: JSON.stringify({ answer: '42', confidence: 0.9, sources: [] }) };
    };

    const repairSchema: any = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: {
        answer: { type: 'string', minLength: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sources: { type: 'array', items: { type: 'string' } },
      },
    };
    const AjvR = require('ajv');
    const validateR = new AjvR({ allErrors: true }).compile(repairSchema);

    const { raw, parsed } = await handleRepair(
      'The answer is forty-two (confidence about 0.9).',
      [{ instancePath: '', message: "must have required property 'answer'", keyword: 'required' }],
      repairSchema,
      ir,
      1,
      gen,
      extractJsonObject,
      ir.repairModel,
    );

    expect(calls[0].model).toBe('omlx:nano');           // differs from ir.model.id
    expect(calls[0].max_tokens).toBe(1200);             // floored at the gen's ceiling
    expect(parsed).toEqual({ answer: '42', confidence: 0.9, sources: [] });
    expect(validateR(parsed)).toBe(true);
    expect(JSON.parse(raw)).toEqual(parsed);
  });
});
