/**
 * RED-137: per-invocation context handed to tool implementations.
 *
 * Tools that need the network should call `ctx.fetch(url, init)` instead of
 * the global `fetch`. When a context is provided by the runner, `ctx.fetch`
 * is bound to the gen's NetworkPolicy — SSRF-guarded, DNS-resolved-all, IP
 * pinned. When no context is provided (e.g. unit tests that call the tool
 * directly), tools should fall back to `globalThis.fetch` so they remain
 * usable in isolation.
 *
 * Pure tools (calculator, read_file) ignore ctx entirely.
 */

import type { NetworkPolicy } from './permissions.js';
import { guardedFetch } from './network-guard.js';

export type ToolContext = {
  /** Tool's registered name, for diagnostics + logging. */
  toolName: string;
  /**
   * Policy-bound fetch. Throws `Network egress denied: ...` on policy
   * violation (the thrown error has a `guardDecision` property with the
   * structured reason, for the trace).
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Abort signal the caller can use to cooperatively cancel. */
  signal?: AbortSignal;
};

/**
 * Build a ToolContext with a fetch bound to the given NetworkPolicy.
 * If the policy is undefined (no `security network:` block), every
 * `ctx.fetch` call will deny — which is the correct deny-by-default.
 */
export function buildToolContext(args: {
  toolName: string;
  policy?: NetworkPolicy;
  signal?: AbortSignal;
}): ToolContext {
  const { toolName, policy, signal } = args;

  const boundFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!policy) {
      const err = new Error(`Network egress denied: tool "${toolName}" has no network policy`);
      (err as any).guardDecision = { allowed: false, host: '', reason: 'no_policy' };
      throw err;
    }
    return guardedFetch(url, init, policy);
  };

  return { toolName, fetch: boundFetch, signal };
}
