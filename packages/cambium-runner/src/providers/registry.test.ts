import { describe, it, expect } from 'vitest';
import { ProviderRegistry, defineProvider, normalizeModelName } from './registry.js';

// RED-393: provider registry foundation.

const stub = (name: string) =>
  defineProvider({
    name,
    supportsDocuments: false,
    async generateText() {
      return { text: `from ${name}` };
    },
    async generateWithTools() {
      return { message: { content: `from ${name}` } };
    },
  });

describe('ProviderRegistry', () => {
  it('registers and resolves by name', () => {
    const reg = new ProviderRegistry();
    reg.register(stub('omlx'));
    expect(reg.has('omlx')).toBe(true);
    expect(reg.get('omlx')?.name).toBe('omlx');
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.names()).toEqual(['omlx']);
  });

  it('a later registration shadows an earlier one (app shadows builtin)', () => {
    const reg = new ProviderRegistry();
    reg.register({ ...stub('anthropic'), supportsDocuments: false });
    reg.register({ ...stub('anthropic'), supportsDocuments: true }); // app override
    expect(reg.get('anthropic')?.supportsDocuments).toBe(true);
    expect(reg.names()).toEqual(['anthropic']); // not duplicated
  });
});

describe('normalizeModelName', () => {
  it('defaults to identity when undefined', () => {
    expect(normalizeModelName(undefined)('gpt-4o')).toBe('gpt-4o');
  });

  it('applies a function transform', () => {
    const fn = normalizeModelName((n) => (n.includes('/') ? n : `anthropic/${n}`));
    expect(fn('claude-3.5')).toBe('anthropic/claude-3.5');
    expect(fn('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('applies an object map with passthrough for unmapped keys', () => {
    const fn = normalizeModelName({ 'gpt-4o': 'my-prod-deploy' });
    expect(fn('gpt-4o')).toBe('my-prod-deploy');
    expect(fn('gpt-4o-mini')).toBe('gpt-4o-mini'); // unmapped → passthrough
  });
});

describe('defineProvider', () => {
  it('returns the provider unchanged (type-inference identity)', () => {
    const p = stub('x');
    expect(defineProvider(p)).toBe(p);
  });
});
