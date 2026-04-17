import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { guardedFetch } from './network-guard.js';
import type { NetworkPolicy } from './permissions.js';

const policy = (overrides: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  allowlist: ['*'],
  denylist: [],
  block_private: true,
  block_metadata: true,
  ...overrides,
});

describe('guardedFetch — end-to-end', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello-from-guarded-fetch');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('blocks DNS-rebinding: hostname resolves to a private IP', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    await expect(
      guardedFetch(
        `http://attacker.example:${port}/`,
        undefined,
        policy({ allowlist: ['*'] }),
        { resolver },
      ),
    ).rejects.toThrow(/Network egress denied.*attacker\.example.*block_private/);
  });

  it('allows connect when policy permits private IPs (block_private off)', async () => {
    const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    const res = await guardedFetch(
      `http://internal.test:${port}/`,
      undefined,
      policy({ allowlist: ['*'], block_private: false }),
      { resolver },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello-from-guarded-fetch');
  });

  it('blocks when host is not in allowlist', async () => {
    const resolver = async () => [{ address: '8.8.8.8', family: 4 as const }];
    await expect(
      guardedFetch(
        `http://api.evil.com/`,
        undefined,
        policy({ allowlist: ['api.tavily.com'] }),
        { resolver },
      ),
    ).rejects.toThrow(/Network egress denied.*api\.evil\.com.*allowlist_miss/);
  });
});
