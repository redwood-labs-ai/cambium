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
| `Validate` | AJV schema validation. First-attempt successes are elided from the trace; only failures and post-repair successes are pushed. | `errors` on failure |
| `Repair` | Repair-loop iteration. Also emitted by the corrector-feedback and grounding paths (one extra attempt each). | `attempt`, `strategy`, `errors_before`, `errors_after` |
| `ValidateAfterRepair` | AJV re-validation after a schema-failure repair attempt. | `errors` on failure |
| `ValidateAfterCorrect` | AJV re-validation after a corrector that returned `corrected: true` modified the output. | `errors` on failure |
| `ValidateAfterCorrectorRepair` | AJV re-validation after a corrector-feedback repair attempt (RED-275). Only emitted when a corrector returned `severity: 'error'` issues that fed back into a repair call. | `errors` on failure |
| `CorrectAfterRepair` | Per-iteration re-run of the corrector after a successful `ValidateAfterCorrectorRepair` (RED-298). `ok: true` when the re-run returned no error-severity issues (the concern was healed); `ok: false` when errors persist and the loop continues (if `max_attempts` allows) or terminates. | `correctors`, `corrected`, `issues` |
| `CorrectAcceptedWithErrors` | Terminal state: a corrector's `max_attempts` was exhausted with error-severity issues still pending (RED-298). The run does NOT fail — the output is schema-valid — but this step is greppable via `jq '.steps[] \| select(.ok == false)'` so downstream consumers can refuse output on unhealed errors. Always `ok: false`. | `corrector`, `attempts_made`, `max_attempts`, `unhealed_issues` |
| `ValidateAfterGrounding` | AJV re-validation after a grounding-failure repair attempt (citation errors fed back into repair). | `errors` on failure |
| `ExtractSignals` / `Trigger` | Signal extraction + trigger evaluation (see [[C - Signals, State, and Triggers]]). |
| `ActionCall` | A trigger's `action :name` side-effect handler invocation (RED-212). | `trigger`, `action`, `input`, `output`, `target` |
| `GroundingCheck` | Citation verification. | `citations_verified`, `failures` |
| `memory.read` | Per memory decl, before `Generate`. See RED-215 section below. | `strategy`, `scope`, `name`, `k`, `hits`, `bytes`, `embed_model?`, `embed_dim?`, `query_source?`, `query_preview?` |
| `memory.write` | Per writable memory decl, after `finalOk`. | `name`, `entry_id`, `bytes`, `written_by`, `strategy?`, `embed_model?` |
| `memory.prune` | On TTL/cap eviction (governance follow-up; wired but not yet fired). | `reason` (`"ttl"` \| `"cap"`), `count` |
| `ExecSpawned` | Exec sandbox started; emitted just before the substrate runs the guest code (RED-249). | `runtime`, `language`, `cpu`, `memory`, `timeout` |
| `ExecCompleted` | Exec finished normally (guest code exited, any `exit_code`). `ok: false` when `exit_code != 0`. | `runtime`, `language`, `duration_ms`, `exit_code`, `mem_peak_mb?`, `stdout_bytes`, `stderr_bytes`, `truncated` |
| `ExecTimeout` | Wall-clock cap hit before the guest finished. | `runtime`, `language`, `duration_ms`, `timeout_seconds`, `reason?` |
| `ExecOOM` | Memory cap hit. | `runtime`, `language`, `duration_ms`, `mem_peak_mb?`, `memory_limit_mb`, `reason?` |
| `ExecEgressDenied` | Substrate refused a network or filesystem operation. | `runtime`, `language`, `duration_ms`, `reason` (future: `kind`, `target`) |
| `ExecCrashed` | Substrate-infrastructure failure (not guest code error). | `runtime`, `language`, `duration_ms`, `reason` |
| `ExecSnapshotLoaded` | `:firecracker`-only (RED-256). Fired between `ExecSpawned` and the outcome event when the snapshot cache interacted with the call. Warm-restore path: cached snapshot was used. Cold-boot-and-save path: first call for a cache key; cold-boot ran and a snapshot was saved inline for next time. | `runtime`, `cache_key`, `restore_ms` (warm path) OR `create_ms` + `note` (cold-and-save path) |
| `ExecSnapshotFallback` | `:firecracker`-only (RED-256). Fired between `ExecSpawned` and the outcome event when the snapshot cache was bypassed; the VM cold-booted without saving a snapshot. | `runtime`, `cache_key`, `reason` (`missing` \| `non_canonical_sizing` \| `load_failed` \| `shared_mem_unsupported` \| `build_locked` \| `allowlist_hash_failed`), `fallback` (`cold_boot`). `allowlist_hash_failed` fires when hashing the filesystem allowlist's source directories threw at dispatch time (RED-258). |
| `tool.exec.unsandboxed` | Dispatch-time event when `runtime: :native` runs `execute_code` without isolation (deprecated; RED-249). Also surfaces as a stderr warning once per process. | `tool`, `deprecated: true` |

## Memory events (RED-215)

Emitted per memory decl alongside the step pipeline. Read events run before `Generate`; write events run after the validate/repair loop succeeds (or are replaced by a retro-agent dispatch when `write_memory_via` is declared).

- **`memory.read`** — fires once per decl. `hits: 0` is normal for empty buckets or `:log` strategy. For `:semantic` the meta includes the `embed_model` and `embed_dim` actually used; for `:sliding_window` it includes `k` (= `size`). Semantic reads additionally surface `query_source` (`"literal" | "arg_field" | "default"`, RED-238) and `query_preview` (the resolved query text, truncated at 200 chars) so trace consumers can tell which input drove the nearest-neighbor search.
- **`memory.write`** — fires once per writable decl on success. `written_by: "default"` for the trivial-default writer; `written_by: "agent:<ClassName>"` when a retro agent authored the write. Retro-agent failure modes emit `memory.write` with `ok: false` (`memory_write_agent_not_found`, `memory_write_agent_failed`, `memory_write_agent_dropped`) — the primary run still exits 0 (best-effort writes).
- **`memory.prune`** — reserved for the governance ticket. Meta shape is locked (`reason`, `count`) so the governance impl lands additively.

## Tool-policy events (RED-137)

Events emitted under `type: "tool.*"` alongside the `ToolCall` step whenever the runtime refuses or consumes a tool dispatch:

- **`tool.permission.denied`** — `ctx.fetch` denied egress. Meta: `tool`, `host`, `reason` (`denylist` | `allowlist_miss` | `block_private` | `block_metadata` | `invalid_url` | `unresolvable` | `unsupported_protocol`), `rule` (`"default"` for built-in blocks), `resolved_ips` (when DNS was consulted).
- **`tool.budget.exceeded`** — a per-tool or per-run `budget` cap was hit before dispatch. Meta: `tool`, `metric` (`max_calls` | `max_tool_calls`), `current`, `increment`, `limit`. A budget violation mid-agentic-loop terminates the loop (force final output); the event appears in the trace before the loop exits.

## See also
- [[N - Failure Modes & Debugging]]
- [[C - Repair Loop]]
- [[S - Tool Sandboxing (RED-137)]]
- [[P - Memory]]
