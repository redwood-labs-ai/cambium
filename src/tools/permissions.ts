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

export type ExecPolicy = {
  allowed: boolean;
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
    out.exec = { allowed: sec.exec.allowed === true };
  }

  return out;
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
