# RED-137: Tool Sandboxing — Network Egress + Budgets

**Doc ID:** gen-dsl/security/sandboxing
**Status:** Shipped
**Supersedes (extends):** [[S - Tool Permissions & Sandboxing]]
**Related:** [[P - Policy Packs (RED-214)]] — bundles the `security` and `budget` shapes defined here into named, reusable packs.

## Problem

Today's `security allow_network: true` is a binary switch validated only at
startup against statically declared `network_hosts`. A tool that internally
calls `fetch("http://169.254.169.254/latest/meta-data/")` passes the static
check and exfiltrates cloud credentials at runtime. There are also no
per-tool budgets — a misbehaving agentic loop can exhaust the entire run
budget on a single tool.

## Goals

1. Block SSRF and metadata-service egress by default.
2. Enforce host allow/deny at fetch time, not just startup.
3. Per-tool call/token/cost budgets with clear errors.
4. Every permission decision lands in the trace.

## DSL surface

```ruby
class Agent < GenModel
  uses :tavily, :linear, :codebase_reader

  security \
    network: {
      allowlist: ["api.tavily.com", "api.linear.app"],
      denylist: [],                  # applied after allowlist; deny wins
      block_private: true,           # RFC1918 + link-local + loopback + ULA. default true
      block_metadata: true,          # 169.254.169.254, metadata.google.internal, etc. default true
    },
    filesystem: {
      roots: ["./packages/scanner/examples"],   # absolute or repo-relative
    }

  budget \
    per_tool: {
      tavily:           { max_calls: 5  },
      linear:           { max_calls: 20 },
      codebase_reader:  { max_calls: 50 },
    },
    per_run: { max_calls: 100 }
end
```

No backcompat with the old `allow_network: true` switch — it's removed.
The new `security network:` block is the only way to grant egress; omitting
it denies all network. `block_private` and `block_metadata` default to
`true` whenever `network:` is present.

## Resolution + enforcement

The runtime installs a fetch interceptor scoped to tool execution. For each
outbound request:

1. Parse URL → hostname.
2. If hostname is an IP literal: check against private/metadata blocks first.
3. Else: resolve via DNS (`dns.lookup`, all addresses). Check **every**
   resolved IP against blocks. If *any* address is blocked → deny. (Prevents
   DNS rebinding where one A record is public, another is `127.0.0.1`.)
4. Check hostname against denylist (suffix match, `*` = wildcard).
5. Check hostname against allowlist (suffix match). If allowlist is set and
   no match → deny.
6. Re-resolve and pin the IP for the actual connection (TOCTOU guard) —
   pass resolved IP via `lookup` option to `fetch`'s underlying agent.

Default blocked ranges (`block_private`):
- `127.0.0.0/8`, `::1/128` (loopback)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918)
- `169.254.0.0/16`, `fe80::/10` (link-local)
- `fc00::/7` (ULA)
- `0.0.0.0/8`, `::/128`

Default blocked metadata hostnames (`block_metadata`):
- `metadata.google.internal`
- `metadata.aws.internal`
- `169.254.169.254` (covered by link-local too, but explicit)

## Budgets

Budget state lives on the run context, not global. Counters per
`(run_id, tool_name)`:

- `calls` — incremented before dispatch.

(`max_bytes`, `max_tokens`, `max_cost_usd` are deferred — see Out of scope.
 `max_calls` is the runaway-loop case and lands real value today without
 requiring a tokenizer or cost reporting in the dispatch path.)

Check happens **before** dispatch. Exceeding any limit raises
`BudgetExceeded` with the limit, current value, and increment that would
have pushed it over. Per-run budget checked after per-tool.

## Trace events

New event types under `tool.*`:

```jsonc
{ "type": "tool.permission.granted",
  "tool": "tavily", "host": "api.tavily.com",
  "resolved_ips": ["1.2.3.4"], "matched": "allowlist" }

{ "type": "tool.permission.denied",
  "tool": "tavily", "host": "169.254.169.254",
  "reason": "block_metadata", "rule": "default" }

{ "type": "tool.budget.consumed",
  "tool": "tavily", "metric": "calls", "value": 3, "limit": 5 }

{ "type": "tool.budget.exceeded",
  "tool": "tavily", "metric": "max_calls",
  "current": 5, "increment": 1, "limit": 5 }
```

## IR shape

`policies.security` extends to:

```jsonc
{
  "security": {
    "network": {
      "allowlist": ["api.tavily.com"],
      "denylist": [],
      "block_private": true,
      "block_metadata": true
    },
    "filesystem": { "roots": ["./examples"] }
  },
  "budget": {
    "per_tool": { "tavily": { "max_calls": 5 } },
    "per_run":  { "max_calls": 100 }
  }
  // v1 supports max_calls only. See "Out of scope" for rationale.
}
```

## Out of scope (this ticket)

- HTTPS cert pinning per host.
- Outbound proxy enforcement.
- Filesystem write sandboxing (read-only roots only for now).
- Byte / token / USD cost budgets. Bytes don't track the real cost (model
  tokens do); tokens need a tokenizer in the dispatch path and a per-model
  strategy; USD needs a tool `_meta` convention for cost reporting.
  `max_calls` covers the runaway-loop case cheaply; the rest lands as a
  follow-up once we settle the tokenizer/`_meta` questions.

## Test plan

- Unit: CIDR matcher, hostname matcher (suffix + wildcard), denylist-wins
  precedence, DNS-resolution-all-addresses, IP-literal handling.
- Integration: a tool that `fetch`es `http://169.254.169.254/` is blocked
  with a `tool.permission.denied` trace event.
- Integration: budget exceeded on call 6 of `max_calls: 5` raises before
  the 6th dispatch and lands in trace.
- Migration: existing gens using the removed `allow_network: true` switch
  fail compilation with a clear error pointing at the new `network:` block.

## Open questions

- Should `block_private` be opt-out per-tool (e.g., `codebase_reader`
  legitimately reads from internal git mirror)? Lean: yes, via tool's
  `permissions.network_hosts` declaring an internal host, which is then
  exempted from `block_private` only if the gen's `security.network.allowlist`
  also contains it. Two-key opt-in.
- Cost reporting: define a small `_meta` convention now or punt to a
  follow-up? Lean: punt — budget on `max_calls` and `max_bytes` lands real
  value without needing every tool to estimate cost.
