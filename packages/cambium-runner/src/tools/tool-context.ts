/**
 * RED-137: per-invocation context handed to tool implementations.
 *
 * Tools that need the network MUST call `ctx.fetch(url, init)` — never
 * `globalThis.fetch`. When provided by the runner, `ctx.fetch` is bound to
 * the gen's NetworkPolicy (SSRF-guarded, DNS-resolved-all, IP pinned).
 *
 * When `ctx` or `ctx.fetch` is absent (e.g. a unit test that calls the tool
 * directly without going through the runner), network-using tools MUST
 * throw rather than fall back to `globalThis.fetch`. Falling back would
 * silently re-open the SSRF surface — this is invariant #22 enforced in
 * every framework builtin. See CLAUDE.md "Non-obvious invariants."
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
