import { describe, it, expect } from 'vitest';
import { redactErrorBody } from './redact.js';

describe('redactErrorBody', () => {
  it('redacts a Bearer token in an Authorization-style value', () => {
    const out = redactErrorBody('Authorization: Bearer sk-abc123defghijkl');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abc123defghijkl');
    expect(out).toContain('Bearer ');
  });

  it('redacts x-api-key labelled value', () => {
    const out = redactErrorBody('x-api-key: sk-ant-api03-faketoken12345');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-api03-faketoken12345');
    expect(out).toContain('x-api-key: ');
  });

  it('redacts x-api-key labelled value with = separator', () => {
    const out = redactErrorBody('x-api-key=sk-ant-api03-faketoken12345');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-api03-faketoken12345');
  });

  it('redacts api_key labelled value', () => {
    const out = redactErrorBody('api_key: mysecretvalue12345678');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('mysecretvalue12345678');
  });

  it('redacts standalone sk-* prefixed token', () => {
    const out = redactErrorBody('use token: sk-ant-api03-xxxxxxxxxxxxxxxx');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-ant-api03-xxxxxxxxxxxxxxxx');
  });

  it('redacts standalone ak-* prefixed token', () => {
    const out = redactErrorBody('found ak-abcdefghijkl in body');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ak-abcdefghijkl');
  });

  it('redacts standalone rk-* prefixed token', () => {
    const out = redactErrorBody('rk-livemode12345678 is the key');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('rk-livemode12345678');
  });

  it('redacts standalone tok-* prefixed token', () => {
    const out = redactErrorBody('tok-validtoken12345 present');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('tok-validtoken12345');
  });

  it('redacts uppercase-prefixed token (SK-, AK- etc.) — case-insensitive match', () => {
    const out = redactErrorBody('invalid key SK-ANT-ABCD1234EFGH in request');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('SK-ANT-ABCD1234EFGH');
    const out2 = redactErrorBody('rejected AK-XXXXXXXXXXXXXXXX');
    expect(out2).toContain('[REDACTED]');
    expect(out2).not.toContain('AK-XXXXXXXXXXXXXXXX');
  });

  it('does not redact short sk- strings (below the 8-char post-prefix minimum)', () => {
    // 'sk-ab' is only 2 chars post-prefix — below the ≥8 lower bound
    const out = redactErrorBody('sk-ab is a short string');
    expect(out).toBe('sk-ab is a short string');
  });

  it('passes a benign billing error body through unchanged', () => {
    const body = 'Your credit balance is too low to access the API.';
    expect(redactErrorBody(body)).toBe(body);
  });

  it('passes non-secret numeric content through unchanged', () => {
    const body = '{"balance":0.00,"message":"Insufficient credits"}';
    expect(redactErrorBody(body)).toBe(body);
  });

  it('passes a realistic Anthropic credit-balance 400 body through unredacted', () => {
    const body = '{"error":{"type":"credit_balance_error","message":"Your credit balance is too low to access the API."}}';
    const out = redactErrorBody(body);
    expect(out).toBe(body);
    expect(out).toContain('Your credit balance is too low');
  });

  it('truncates to 1500 chars', () => {
    const body = 'x'.repeat(2000);
    expect(redactErrorBody(body).length).toBe(1500);
  });

  it('applies redaction before truncation (no partial secret near the cap)', () => {
    // Build a body where a bearer token starts at char 1480 (past 1500 after
    // a raw slice would cut it). With redact-then-truncate the token is
    // replaced in full and the result is safely ≤1500.
    const prefix = 'a'.repeat(1480);
    const token = 'Bearer sk-ant-api03-supersecretkey12345';
    const suffix = 'b'.repeat(100);
    const body = prefix + token + suffix;
    const out = redactErrorBody(body);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).not.toContain('sk-ant-api03-supersecretkey12345');
    expect(out).not.toContain('supersecretkey12345');
  });

  it('returns empty string for empty input', () => {
    expect(redactErrorBody('')).toBe('');
  });

  it('returns benign body unchanged for garbage/non-credential input', () => {
    const body = 'no secrets here at all';
    expect(redactErrorBody(body)).toBe(body);
  });
});
