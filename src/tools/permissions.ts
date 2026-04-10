import type { ToolDefinition } from './registry.js';

export type ToolPermissions = {
  network?: boolean;         // can make network requests?
  network_hosts?: string[];  // if network=true, restrict to these hosts
  filesystem?: boolean;      // can access filesystem?
  filesystem_paths?: string[]; // if filesystem=true, restrict to these paths
  exec?: boolean;            // can execute child processes?
  pure?: boolean;            // deterministic, no side effects? (default: true)
};

export type PermissionViolation = {
  tool: string;
  permission: string;
  message: string;
};

/**
 * Extended tool definition with optional permissions block.
 */
export type ToolDefinitionWithPerms = ToolDefinition & {
  permissions?: ToolPermissions;
};

/**
 * Validate that a tool's declared permissions are acceptable
 * for the current security policy.
 */
export function validateToolPermissions(
  def: ToolDefinitionWithPerms,
  policy: SecurityPolicy,
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];
  const perms = def.permissions ?? { pure: true };

  if (perms.network && !policy.allow_network) {
    violations.push({
      tool: def.name,
      permission: 'network',
      message: `Tool "${def.name}" declares network access but security policy denies it`,
    });
  }

  if (perms.network && policy.allow_network && policy.network_hosts_allowlist) {
    const toolHosts = perms.network_hosts ?? [];
    for (const host of toolHosts) {
      if (!policy.network_hosts_allowlist.includes(host)) {
        violations.push({
          tool: def.name,
          permission: 'network',
          message: `Tool "${def.name}" wants access to host "${host}" which is not in the allowlist`,
        });
      }
    }
  }

  if (perms.filesystem && !policy.allow_filesystem) {
    violations.push({
      tool: def.name,
      permission: 'filesystem',
      message: `Tool "${def.name}" declares filesystem access but security policy denies it`,
    });
  }

  if (perms.exec && !policy.allow_exec) {
    violations.push({
      tool: def.name,
      permission: 'exec',
      message: `Tool "${def.name}" declares exec access but security policy denies it`,
    });
  }

  return violations;
}

/**
 * Security policy — set via config/gen.yml or environment.
 * Deny-by-default: everything false unless explicitly allowed.
 */
export type SecurityPolicy = {
  allow_network: boolean;
  network_hosts_allowlist?: string[];
  allow_filesystem: boolean;
  filesystem_paths_allowlist?: string[];
  allow_exec: boolean;
};

export const DEFAULT_POLICY: SecurityPolicy = {
  allow_network: false,
  allow_filesystem: false,
  allow_exec: false,
};

/**
 * Build a security policy from IR policies and environment.
 */
export function buildSecurityPolicy(irPolicies: any): SecurityPolicy {
  const security = irPolicies?.security ?? {};
  return {
    allow_network: security.allow_network ?? false,
    network_hosts_allowlist: security.network_hosts_allowlist,
    allow_filesystem: security.allow_filesystem ?? false,
    filesystem_paths_allowlist: security.filesystem_paths_allowlist,
    allow_exec: security.allow_exec ?? false,
  };
}

/**
 * Validate all tools in the allowlist against the security policy.
 * Returns violations if any tool requests permissions the policy denies.
 */
export function validateAllToolPermissions(
  toolDefs: Map<string, ToolDefinitionWithPerms> | { get(name: string): ToolDefinitionWithPerms | undefined },
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
