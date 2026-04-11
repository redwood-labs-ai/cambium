import { describe, it, expect } from 'vitest';
import { handleRepair } from './step-handlers.js';

const schema = {
  $id: 'GaiaAnswer',
  type: 'object',
  additionalProperties: false,
  properties: { reasoning: { type: 'string' }, answer: { type: 'string' } },
  required: ['reasoning', 'answer'],
};

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
});
