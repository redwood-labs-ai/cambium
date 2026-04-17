import type { ToolDefinition } from './registry.js';

/**
 * Permissions a tool declares about itself in its .tool.json.
 * The runtime uses these for the *static* gen-vs-tool compatibility check
 * at startup. The runtime guard in `network-guard.ts` handles fetch-time
 * enforcement (CIDR, DNS resolution, IP pinning).
 */
export type ToolPermissions = {
  network?: boolean;
  network_hosts?: string[];   // hosts the tool intends to contact
  filesystem?: boolean;
  filesystem_paths?: string[];
  exec?: boolean;
  pure?: boolean;
};

export type ToolDefinitionWithPerms = ToolDefinition & {
  permissions?: ToolPermissions;
};

export type PermissionViolation = {
  tool: string;
  permission: 'network' | 'filesystem' | 'exec' | 'host';
  message: string;
};

/**
 * Security policy as it appears in the IR (post-RED-137 nested shape).
 * Mirrors `policies.security` from compile.rb. All fields optional;
 * absence means "deny that capability".
 */
export type NetworkPolicy = {
  allowlist: string[];        // hostname suffixes; ["*"] = any host
  denylist: string[];         // applied after allowlist; deny wins
  block_private: boolean;     // RFC1918 + link-local + loopback + ULA
  block_metadata: boolean;    // 169.254.169.254 etc.
};

export type FilesystemPolicy = {
  roots: string[];
};

/** Per-call exec scope for network egress. `'inherit'` at the DSL level
 *  is resolved at parse time into a NetworkPolicy copy of the gen's
 *  outer `security.network` (see `buildSecurityPolicy`). After parsing
 *  the value is either `'none'` or a concrete `NetworkPolicy`. */
export type ExecScopedNetwork = 'none' | NetworkPolicy;

/** Per-call exec scope for filesystem access. Same `:inherit` resolution
 *  as `ExecScopedNetwork`. After parsing the value is either `'none'` or
 *  a concrete `{ allowlist_paths: string[] }`. */
export type ExecScopedFilesystem = 'none' | { allowlist_paths: string[] };

/** RED-248 resolved exec policy.
 *
 *  The legacy `{ allowed: true }` DSL shape resolves on the Ruby side to
 *  `{ allowed: true, runtime: 'native' }` at parse time — the `:native`
 *  substrate is the deprecated fig-leaf. Runtime-side migration warnings
 *  for that path land in RED-249.
 *
 *  New-shape gens provide `runtime:` explicitly (required) and any of
 *  `cpu` / `memory` / `timeout` / `network` / `filesystem` /
 *  `max_output_bytes` the author cares to pin. Defaults applied here
 *  where the DSL didn't provide one. */
export type ExecPolicy = {
  allowed: boolean;
  runtime?: 'wasm' | 'firecracker' | 'native';
  cpu?: number;
  memory?: number;
  timeout?: number;
  network?: ExecScopedNetwork;
  filesystem?: ExecScopedFilesystem;
  maxOutputBytes?: number;
};

export type SecurityPolicy = {
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  exec?: ExecPolicy;
};

export const DEFAULT_POLICY: SecurityPolicy = {};

/**
 * Build a runtime SecurityPolicy from raw IR `policies` block.
 * Tolerates undefined / partial input. Network defaults `block_private`
 * and `block_metadata` to true if `network:` is present at all.
 */
export function buildSecurityPolicy(irPolicies: any): SecurityPolicy {
  const sec = irPolicies?.security;
  if (!sec) return {};

  const out: SecurityPolicy = {};

  if (sec.network) {
    out.network = {
      allowlist:      Array.isArray(sec.network.allowlist) ? sec.network.allowlist : [],
      denylist:       Array.isArray(sec.network.denylist)  ? sec.network.denylist  : [],
      block_private:  sec.network.block_private  ?? true,
      block_metadata: sec.network.block_metadata ?? true,
    };
  }

  if (sec.filesystem) {
    out.filesystem = {
      roots: Array.isArray(sec.filesystem.roots) ? sec.filesystem.roots : [],
    };
  }

  if (sec.exec) {
    out.exec = buildExecPolicy(sec.exec, out.network);
  }

  return out;
}

/** RED-248: resolve the IR's exec shape into an `ExecPolicy`.
 *  Handles `:inherit` by copying the outer `NetworkPolicy` (resolved
 *  from `security.network` above). Inheritance is wholesale — narrower-
 *  than-outer is permitted if authors explicitly pass a Hash; widening
 *  beyond the outer network is something the design note flagged as
 *  intersection-semantics but v1 doesn't enforce at parse time. */
/** Valid runtime names. Duplicated from `exec-substrate/registry.ts`'s
 *  `KNOWN_SUBSTRATES` on purpose — that module owns runtime dispatch,
 *  this one owns policy shape, and we don't want a cycle. A test locks
 *  the two lists in sync. */
const KNOWN_RUNTIMES: readonly ExecPolicy['runtime'][] = ['wasm', 'firecracker', 'native'] as const;

function buildExecPolicy(
  exec: any,
  outerNetwork: NetworkPolicy | undefined,
): ExecPolicy {
  const out: ExecPolicy = { allowed: exec.allowed === true };

  if (typeof exec.runtime === 'string') {
    // Ruby side validates this; re-validate here so a tampered or
    // hand-crafted IR (bypassing the compile step) can't smuggle an
    // arbitrary string into `getSubstrate(name)` at dispatch time.
    if (!(KNOWN_RUNTIMES as readonly string[]).includes(exec.runtime)) {
      throw new Error(
        `Invalid security.exec.runtime: "${exec.runtime}". ` +
        `Must be one of: ${KNOWN_RUNTIMES.join(', ')}.`,
      );
    }
    out.runtime = exec.runtime as ExecPolicy['runtime'];
  }
  if (typeof exec.cpu === 'number') out.cpu = exec.cpu;
  if (typeof exec.memory === 'number') out.memory = exec.memory;
  if (typeof exec.timeout === 'number') out.timeout = exec.timeout;
  if (typeof exec.max_output_bytes === 'number') out.maxOutputBytes = exec.max_output_bytes;

  if (exec.network !== undefined) {
    out.network = resolveScopedNetwork(exec.network, outerNetwork);
  }
  if (exec.filesystem !== undefined) {
    out.filesystem = resolveScopedFilesystem(exec.filesystem);
  }

  return out;
}

function resolveScopedNetwork(
  value: any,
  outer: NetworkPolicy | undefined,
): ExecScopedNetwork {
  if (value === 'none') return 'none';
  if (value === 'inherit') {
    // No outer network policy means `:inherit` resolves to `none` —
    // the gen declared no network capability, so the exec sandbox
    // inherits none. Safer default than "allow whatever."
    return outer
      ? { ...outer, allowlist: [...outer.allowlist], denylist: [...outer.denylist] }
      : 'none';
  }
  // Hash form — normalize like the outer network (same parse shape).
  return {
    allowlist:      Array.isArray(value.allowlist) ? value.allowlist : [],
    denylist:       Array.isArray(value.denylist)  ? value.denylist  : [],
    block_private:  value.block_private  ?? true,
    block_metadata: value.block_metadata ?? true,
  };
}

function resolveScopedFilesystem(value: any): ExecScopedFilesystem {
  if (value === 'none') return 'none';
  if (value === 'inherit') {
    // Filesystem inheritance is not yet wired. `:inherit` currently
    // resolves to `none`; the outer `security filesystem:` primitive
    // uses `{ roots: [...] }` which is a different shape than exec's
    // `{ allowlist_paths: [...] }`. Bridging the two needs a design
    // decision about whether they should unify — flagged for future
    // work; safe default is deny.
    return 'none';
  }
  return {
    allowlist_paths: Array.isArray(value.allowlist_paths) ? value.allowlist_paths : [],
  };
}

/**
 * Suffix-based hostname match. `*` matches any host. `api.example.com`
 * in the list matches itself and any subdomain (e.g. `v2.api.example.com`).
 * Bare `example.com` does NOT match `api.example.com` — entries must be
 * the exact base or include the subdomain you want.
 *
 * (Strict suffix-with-dot semantics avoid `evilexample.com` matching
 * `example.com`.)
 */
export function hostMatchesList(host: string, list: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of list) {
    const e = entry.toLowerCase();
    if (e === '*') return true;
    if (h === e) return true;
    if (h.endsWith('.' + e)) return true;
  }
  return false;
}

/**
 * Static check: does this tool's *declared* network intent fit inside the
 * gen's network policy? Run at startup. Catches "tool wants to talk to
 * api.evil.com but gen only allows api.tavily.com" at compile-ish time;
 * the runtime guard catches everything else (SSRF, IP literals, DNS
 * rebinding, undeclared hosts).
 */
export function validateToolPermissions(
  def: ToolDefinitionWithPerms,
  policy: SecurityPolicy,
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];
  const perms = def.permissions ?? { pure: true };

  if (perms.network) {
    if (!policy.network) {
      violations.push({
        tool: def.name,
        permission: 'network',
        message: `Tool "${def.name}" requires network access but the gen's security policy has no network: block`,
      });
    } else if (policy.network.allowlist.length > 0 && !policy.network.allowlist.includes('*')) {
      // Tool's declared hosts must each be reachable under the gen's allowlist.
      const toolHosts = perms.network_hosts ?? [];
      for (const host of toolHosts) {
        if (!hostMatchesList(host, policy.network.allowlist)) {
          violations.push({
            tool: def.name,
            permission: 'host',
            message: `Tool "${def.name}" declares host "${host}" but gen's network.allowlist doesn't permit it`,
          });
        }
      }
    }
  }

  if (perms.filesystem && !policy.filesystem) {
    violations.push({
      tool: def.name,
      permission: 'filesystem',
      message: `Tool "${def.name}" requires filesystem access but the gen's security policy has no filesystem: block`,
    });
  }

  if (perms.exec && !policy.exec?.allowed) {
    violations.push({
      tool: def.name,
      permission: 'exec',
      message: `Tool "${def.name}" requires exec but the gen's security policy does not set exec: { allowed: true }`,
    });
  }

  return violations;
}

export function validateAllToolPermissions(
  toolDefs: { get(name: string): ToolDefinitionWithPerms | undefined },
  allowlist: string[],
  policy: SecurityPolicy,
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];
  for (const name of allowlist) {
    const def = toolDefs.get(name);
    if (!def) continue;
    violations.push(...validateToolPermissions(def, policy));
  }
  return violations;
}
