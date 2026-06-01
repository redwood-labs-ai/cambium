import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from './registry.js';
import { buildBuiltinRegistry } from './builtins.js';

// RED-393 phase 3: app/providers discovery. loadFromDir derives the provider
// name from the filename, requires `export default` of a provider with both
// generate methods, and applies the RED-214/275 path-traversal + shape guards.

let dir: string;

const PROVIDER = (body = '') => `
export default {
  name: 'custom',
  supportsDocuments: false,
  async generateText() { return { text: 'ok' }; },
  async generateWithTools() { return { message: { content: 'ok' } }; },
  ${body}
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cambium-providers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ProviderRegistry.loadFromDir', () => {
  it('is a no-op when the directory does not exist', async () => {
    const reg = new ProviderRegistry();
    await reg.loadFromDir(join(dir, 'nope'));
    expect(reg.names()).toEqual([]);
  });

  it('discovers a provider and derives its name from the filename', async () => {
    writeFileSync(join(dir, 'custom.ts'), PROVIDER());
    const reg = new ProviderRegistry();
    await reg.loadFromDir(dir);
    expect(reg.has('custom')).toBe(true);
    expect(reg.get('custom')?.supportsDocuments).toBe(false);
  });

  it('app provider shadows a same-named built-in (load built-ins first)', async () => {
    // A file named omlx.ts overrides the built-in omlx provider.
    writeFileSync(
      join(dir, 'omlx.ts'),
      `export default { name: 'omlx', supportsDocuments: true,
        async generateText() { return { text: 'shadowed' }; },
        async generateWithTools() { return { message: { content: 'shadowed' } }; } };`,
    );
    const reg = buildBuiltinRegistry();
    expect(reg.get('omlx')?.supportsDocuments).toBe(false); // built-in
    await reg.loadFromDir(dir);
    expect(reg.get('omlx')?.supportsDocuments).toBe(true); // shadowed by app
    expect((await reg.get('omlx')!.generateText({ model: 'x', system: '', prompt: '' })).text).toBe('shadowed');
  });

  it('skips .test.ts and .d.ts files', async () => {
    writeFileSync(join(dir, 'custom.ts'), PROVIDER());
    writeFileSync(join(dir, 'custom.test.ts'), `export default {};`);
    writeFileSync(join(dir, 'types.d.ts'), `export type X = number;`);
    const reg = new ProviderRegistry();
    await reg.loadFromDir(dir);
    expect(reg.names()).toEqual(['custom']);
  });

  it('rejects a filename whose basename is not a valid model-id prefix', async () => {
    writeFileSync(join(dir, 'Bad-Name.ts'), PROVIDER());
    const reg = new ProviderRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/model-id prefix/);
  });

  it('rejects a module that does not export default an object', async () => {
    writeFileSync(join(dir, 'broken.ts'), `export const notDefault = 1;`);
    const reg = new ProviderRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/export default/);
  });

  it('rejects a provider missing a generate method', async () => {
    writeFileSync(
      join(dir, 'partial.ts'),
      `export default { name: 'partial', supportsDocuments: false, async generateText() { return { text: '' }; } };`,
    );
    const reg = new ProviderRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/generateText and generateWithTools/);
  });

  it('rejects a provider whose declared name disagrees with the filename', async () => {
    writeFileSync(
      join(dir, 'openrouter.ts'),
      `export default { name: 'something_else', supportsDocuments: false,
        async generateText() { return { text: '' }; },
        async generateWithTools() { return { message: { content: '' } }; } };`,
    );
    const reg = new ProviderRegistry();
    await expect(reg.loadFromDir(dir)).rejects.toThrow(/filename requires "openrouter"/);
  });
});
