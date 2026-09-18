import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildTypesafeRequest, normalizeTypesafeResponse, TYPESAFE_DEFAULT_BASEURL } from './typesafe.js';
import { typesafeProvider, buildBuiltinRegistry } from './builtins.js';
import { ProviderHttpError, ProviderConnectionError } from './types.js';
import { _resetValidatorCacheForTesting } from './base-url-validator.js';
import { isTransientProviderError } from '../runner.js';

describe('buildTypesafeRequest', () => {
  it('maps a choice question to type "choice" with criteria, preserving a null description', () => {
    const body = buildTypesafeRequest({
      model: 'jev-latest',
      state: { task: 'route', context: { document: 'text' } },
      questions: {
        department: {
          kind: 'choice',
          instructions: 'Which team?',
          options: { billing: 'Payment issues', technical: null },
        },
        is_urgent: { kind: 'boolean', instructions: 'Is it urgent?' },
      },
    });

    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ task: 'route', context: { document: 'text' } });
    expect(body.questions.department).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'Payment issues', technical: null },
    });
    expect(body.questions.is_urgent).toEqual({
      type: 'noul',
      instructions: 'Is it urgent?',
    });
  });
});

describe('normalizeTypesafeResponse', () => {
  const questions = {
    department: {
      kind: 'choice' as const,
      instructions: 'Which team?',
      options: { billing: 'Payment issues', technical: null },
    },
    is_urgent: { kind: 'boolean' as const, instructions: 'Is it urgent?' },
  };

  it('normalizes a choice + noul response, including usage mapping', () => {
    const result = normalizeTypesafeResponse(
      {
        model: 'jev-latest',
        answers: {
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.84, technical: 0.16 },
            confidence: 0.596,
          },
          is_urgent: { type: 'noul', noul: 0.999 },
        },
        usage: { input_tokens: 312, output_tokens: 48 },
      },
      questions,
    );

    expect(result.answers.department).toEqual({
      kind: 'choice',
      choice: 'billing',
      confidence: 0.596,
      probabilities: { billing: 0.84, technical: 0.16 },
    });
    expect(result.answers.is_urgent).toEqual({ kind: 'boolean', probability: 0.999 });
    expect(result.usage).toEqual({ prompt_tokens: 312, completion_tokens: 48, total_tokens: 360 });
  });

  it('omits usage when the response carries none', () => {
    const result = normalizeTypesafeResponse(
      {
        answers: {
          department: { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 1 },
          is_urgent: { type: 'noul', noul: 0 },
        },
      },
      questions,
    );
    expect(result.usage).toBeUndefined();
  });

  it('throws naming the field when an answer is missing', () => {
    expect(() =>
      normalizeTypesafeResponse({ answers: { department: { type: 'choice', choice: 'billing', probabilities: {}, confidence: 1 } } }, questions),
    ).toThrow(/'is_urgent'/);
  });

  it('throws naming the field when the answer type does not match the question kind', () => {
    expect(() =>
      normalizeTypesafeResponse(
        {
          answers: {
            department: { type: 'noul', noul: 0.5 },
            is_urgent: { type: 'noul', noul: 0.5 },
          },
        },
        questions,
      ),
    ).toThrow(/'department'/);
  });

  it('throws naming the field when a choice answers outside the declared option set', () => {
    expect(() =>
      normalizeTypesafeResponse(
        {
          answers: {
            department: { type: 'choice', choice: 'sales', probabilities: {}, confidence: 1 },
            is_urgent: { type: 'noul', noul: 0.5 },
          },
        },
        questions,
      ),
    ).toThrow(/'department'.*'sales'/s);
  });

  it('throws when "answers" is missing entirely', () => {
    expect(() => normalizeTypesafeResponse({}, questions)).toThrow(/missing "answers"/);
  });
});

// ── typesafeProvider (bespoke CambiumProvider) ─────────────────────────

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function stubTypesafeFetch(impl: (url: string, init: any) => any): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  process.env.CAMBIUM_TYPESAFE_API_KEY = 'test-key';
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.CAMBIUM_TYPESAFE_BASEURL;
  _resetValidatorCacheForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
  _resetValidatorCacheForTesting();
});

const QUESTIONS = {
  ok: { kind: 'boolean' as const, instructions: 'ok?' },
};

describe('typesafeProvider.decide — HTTP', () => {
  it('sends the request to /v1/systemone with a bearer token', async () => {
    stubTypesafeFetch(async (url: string, init: any) => {
      expect(url).toBe(`${TYPESAFE_DEFAULT_BASEURL}/v1/systemone`);
      expect(init.headers.authorization).toBe('Bearer test-key');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('jev-latest');
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { ok: { type: 'noul', noul: 0.9 } } }),
        text: async () => '',
      };
    });
    const result = await typesafeProvider.decide!({ model: 'jev-latest', state: { task: 't', context: {} }, questions: QUESTIONS });
    expect(result.answers.ok).toEqual({ kind: 'boolean', probability: 0.9 });
  });

  it('401 → ProviderHttpError with redacted body', async () => {
    stubTypesafeFetch(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"Bearer sk-fakefaketoken12345 rejected"}',
      json: async () => { throw new Error('not json'); },
    }));
    const err: any = await typesafeProvider
      .decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('TypeSafe error: HTTP 401');
    expect(err.message).not.toContain('sk-fakefaketoken12345');
    expect(err.message).toContain('[REDACTED]');
    expect(isTransientProviderError(err)).toBe(false);
  });

  it('422 → ProviderHttpError, deterministic (no fallback)', async () => {
    stubTypesafeFetch(async () => ({
      ok: false,
      status: 422,
      text: async () => 'validation failed: missing question',
      json: async () => { throw new Error('not json'); },
    }));
    const err: any = await typesafeProvider
      .decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(422);
    expect(isTransientProviderError(err)).toBe(false);
  });

  it('429 → ProviderHttpError, transient', async () => {
    stubTypesafeFetch(async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
      json: async () => { throw new Error('not json'); },
    }));
    const err: any = await typesafeProvider
      .decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(429);
    expect(isTransientProviderError(err)).toBe(true);
  });

  it('529 → ProviderHttpError, transient', async () => {
    stubTypesafeFetch(async () => ({
      ok: false,
      status: 529,
      text: async () => 'overloaded',
      json: async () => { throw new Error('not json'); },
    }));
    const err: any = await typesafeProvider
      .decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(529);
    expect(isTransientProviderError(err)).toBe(true);
  });

  it('a fetch rejection surfaces as ProviderConnectionError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const err: any = await typesafeProvider
      .decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderConnectionError);
    expect(err.status).toBe(0);
    expect(isTransientProviderError(err)).toBe(true);
  });

  it('missing API key throws a plain Error naming the env vars', async () => {
    delete process.env.CAMBIUM_TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    await expect(
      typesafeProvider.decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS }),
    ).rejects.toThrow(/TYPESAFE_API_KEY \(or CAMBIUM_TYPESAFE_API_KEY\) is required/);
  });

  it('falls back to bare TYPESAFE_API_KEY when CAMBIUM_TYPESAFE_API_KEY is unset', async () => {
    delete process.env.CAMBIUM_TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'bare-key';
    stubTypesafeFetch(async (_url: string, init: any) => {
      expect(init.headers.authorization).toBe('Bearer bare-key');
      return { ok: true, status: 200, json: async () => ({ answers: { ok: { type: 'noul', noul: 0 } } }), text: async () => '' };
    });
    await typesafeProvider.decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS });
  });

  it('a private-range CAMBIUM_TYPESAFE_BASEURL is refused by validateProviderBaseUrl', async () => {
    process.env.CAMBIUM_TYPESAFE_BASEURL = 'https://192.168.1.50';
    await expect(
      typesafeProvider.decide!({ model: 'jev-latest', state: {}, questions: QUESTIONS }),
    ).rejects.toThrow(/private\/metadata IP range/);
  });
});

describe('typesafeProvider — generateText/generateWithTools stubs', () => {
  it('generateText throws a deterministic pointer to mode :decision', async () => {
    await expect(typesafeProvider.generateText({ model: 'jev-latest', system: 's', prompt: 'p' })).rejects.toThrow(
      /Jev does not generate text.*mode :decision/,
    );
  });

  it('generateWithTools throws the same pointer', async () => {
    await expect(
      typesafeProvider.generateWithTools({ model: 'jev-latest', messages: [], tools: [] }),
    ).rejects.toThrow(/Jev does not generate text.*mode :decision/);
  });
});

describe('typesafeProvider registration', () => {
  it('is registered in the built-in registry under "typesafe"', () => {
    const reg = buildBuiltinRegistry();
    expect(reg.get('typesafe')).toBe(typesafeProvider);
    expect(reg.names()).toContain('typesafe');
  });

  it('declares decide but no supportsDocuments', () => {
    expect(typeof typesafeProvider.decide).toBe('function');
    expect(typesafeProvider.supportsDocuments).toBe(false);
  });
});
