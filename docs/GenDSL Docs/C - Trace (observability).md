# Runtime: Trace (observability)

**Doc ID:** gen-dsl/runtime/trace

## Purpose
Make every run debuggable and enterprise-auditable. The trace is the canonical record of what the runtime did, what policies fired, and why.

## Semantics (normative)

A trace MUST include:

- Run id, timestamp, app version
- Model id + parameters
- Each IR step input/output (or hashes, per policy)
- Tool calls with typed I/O (`ToolCall` step)
- Validation errors
- Repair attempts
- Timing + token counts

## Step types

| Type | When | Key meta |
|---|---|---|
| `SecurityCheck` | Startup; before any generation. Validates declared tools against the gen's `security` policy. | `tools_checked`, `policy`, `packs` (pack names that contributed slots, RED-214) |
| `Generate` | Single-turn model call. | `prompt`, `raw`, `usage` |
| `AgenticTurn` | One iteration of the agentic loop. | `turn`, `tool_calls`, `results`, `usage` |
| `ToolCall` | A single tool dispatch. | `tool`, `operation`, `input`, `output` |
| `Validate` | AJV schema validation. | `errors` on failure |
| `Repair` | Repair-loop iteration. | `attempt`, `strategy`, `errors_before`, `errors_after` |
| `ExtractSignals` / `Trigger` | Signal extraction + trigger evaluation (see [[C - Signals, State, and Triggers]]). |
| `GroundingCheck` | Citation verification. | `citations_verified`, `failures` |

## Tool-policy events (RED-137)

Events emitted under `type: "tool.*"` alongside the `ToolCall` step whenever the runtime refuses or consumes a tool dispatch:

- **`tool.permission.denied`** — `ctx.fetch` denied egress. Meta: `tool`, `host`, `reason` (`denylist` | `allowlist_miss` | `block_private` | `block_metadata` | `invalid_url` | `unresolvable` | `unsupported_protocol`), `rule` (`"default"` for built-in blocks), `resolved_ips` (when DNS was consulted).
- **`tool.budget.exceeded`** — a per-tool or per-run `budget` cap was hit before dispatch. Meta: `tool`, `metric` (`max_calls` | `max_tool_calls`), `current`, `increment`, `limit`. A budget violation mid-agentic-loop terminates the loop (force final output); the event appears in the trace before the loop exits.

## See also
- [[N - Failure Modes & Debugging]]
- [[C - Repair Loop]]
- [[S - Tool Sandboxing (RED-137)]]
