import { describe, it, expect } from 'vitest';
import { formatValidationErrors, handleValidate } from './step-handlers.js';

describe('formatValidationErrors (RED-138)', () => {
  it('formats required field errors', () => {
    const errors = [{ keyword: 'required', instancePath: '/data', params: { missingProperty: 'answer' } }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['missing required field: /data/answer']);
  });

  it('formats additionalProperties errors', () => {
    const errors = [{ keyword: 'additionalProperties', instancePath: '', params: { additionalProperty: 'extra' } }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['unexpected field: /extra']);
  });

  it('formats type errors', () => {
    const errors = [{ keyword: 'type', instancePath: '/count', params: { type: 'number' }, instance: 'hello' }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['/count: expected number, got string']);
  });

  it('formats enum errors', () => {
    const errors = [{ keyword: 'enum', instancePath: '/status', params: { allowedValues: ['active', 'inactive'] } }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['/status: value must be one of [active, inactive]']);
  });

  it('falls back to message for unknown keywords', () => {
    const errors = [{ keyword: 'custom', instancePath: '/x', message: 'custom check failed' }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['/x: custom check failed']);
  });

  it('handles root path', () => {
    const errors = [{ keyword: 'required', instancePath: '', params: { missingProperty: 'name' } }];
    const result = formatValidationErrors(errors);
    expect(result).toEqual(['missing required field: /name']);
  });
});

describe('handleValidate (RED-138)', () => {
  it('returns validation_diff in meta on failure', () => {
    const schema = {
      $id: 'Test',
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };

    // Mock validate function that reports errors
    const mockValidate: any = (data: any) => {
      mockValidate.errors = [{ keyword: 'required', instancePath: '', params: { missingProperty: 'answer' } }];
      return false;
    };

    const result = handleValidate({ wrong: true }, mockValidate);
    expect(result.ok).toBe(false);
    expect(result.meta?.validation_diff).toEqual(['missing required field: /answer']);
  });

  it('returns no meta on success', () => {
    const mockValidate: any = () => {
      mockValidate.errors = null;
      return true;
    };

    const result = handleValidate({ answer: 'yes' }, mockValidate);
    expect(result.ok).toBe(true);
    expect(result.meta).toBeUndefined();
  });
});
