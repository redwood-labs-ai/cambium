# Security: Tool Permissions & Sandboxing

> **Superseded by [[S - Tool Sandboxing (RED-137)]].**
> The flat `security allow_network: true` / `allow_filesystem: true` / `allow_exec: true`
> / `network_hosts_allowlist: [...]` switches described below have been removed. Use
> the nested `security network: { allowlist: [...], ... }, filesystem: { roots: [...] }, exec: { allowed: true }`
> form. The runtime now enforces egress at fetch time (SSRF guard, DNS
> resolution of all addresses, IP pinning) and supports per-tool call budgets via
> the new top-level `budget` primitive.
>
> This doc is retained for historical context on the static-check design; the
> tool-side declaration shape (`permissions` block in `.tool.json`) is unchanged.

**Doc ID:** gen-dsl/security/tools

## Purpose
Prevent tool-enabled generation from becoming "prompt-to-RCE." Every tool declares what it can do; the runtime enforces what the policy allows.

## Semantics (normative)
- Tools are **denied by default**. No tool can execute unless declared in `uses`.
- Tools MAY declare a `permissions` block in their `.tool.json`.
- Tools without `permissions` are treated as **pure** (no side effects).
- The runtime validates all tool permissions against the security policy **before execution**.
- Permission violations halt the run with an error in the trace.

## Permission types

| Permission | Default | Description |
|-----------|---------|-------------|
| `pure` | true | No side effects. Deterministic. (e.g., calculator) |
| `network` | false | Can make network requests. |
| `network_hosts` | [] | If network=true, restrict to these hosts only. |
| `filesystem` | false | Can read/write files. |
| `filesystem_paths` | [] | If filesystem=true, restrict to these paths. |
| `exec` | false | Can execute child processes. **Review carefully.** |

## Tool definition with permissions

```json
{
  "name": "api_client",
  "description": "Fetches data from an external API",
  "permissions": {
    "network": true,
    "network_hosts": ["api.example.com"]
  },
  "inputSchema": { ... },
  "outputSchema": { ... }
}
```

## Security policy (DSL)

Post-RED-137 syntax — see [[S - Tool Sandboxing (RED-137)]] for the full shape:

```ruby
class Agent < GenModel
  uses :calculator, :api_client
  security network: { allowlist: ["api.example.com"] }
end
```

The legacy `allow_network: true, network_hosts_allowlist: [...]` form is no
longer accepted and will raise `ArgumentError` at compile time.

## Default policy
Deny everything. Pure tools always pass. This is the safe default — you must explicitly opt in to network, filesystem, or exec.

## Enforcement
1. Tools declare permissions in `.tool.json`
2. GenModel declares security policy (or uses default deny-all)
3. Runner validates all declared tools against the policy at startup
4. If any tool requests a permission the policy denies → error, run halts
5. SecurityCheck step appears in the trace showing what was checked

## Lint integration
`cambium lint` flags tools that declare network, filesystem, or exec permissions as warnings. Tools declaring `exec` get special attention: "review carefully."

## See also
- [[P - uses (tools)]]
- [[S - Secrets & Data Boundaries]]
- [[C - Trace (observability)]]
