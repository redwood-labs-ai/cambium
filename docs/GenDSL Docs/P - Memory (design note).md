# Memory Primitive — Design Note

**Doc ID:** gen-dsl/primitives/memory
**Status:** Design — decisions locked, ready for implementation
**Linear:** [RED-215](https://linear.app/redwood-labs/issue/RED-215)
**Coordinates with:** [RED-237](https://linear.app/redwood-labs/issue/RED-237) (workspace `:default` model aliases — memory pools' `embed:` slot uses the same aliasing mechanism)
**Related:** [[P - extract (signals)]], [[C - Trace (observability)]], [[S - Tool Sandboxing (RED-137)]], [[P - Policy Packs (RED-214)]]

## Motivation

Every interesting agent eventually wants memory: "remember what the user
told me last week," "don't re-ask questions I've already asked in this
session," "recall the three most-relevant prior cases before answering."

In almost every framework this is hand-plumbed — the developer wires up
a vector store, writes retrieval code, stitches results into the
prompt, decides what to save after each turn, handles retention. The
Cambium bet is the same as RED-137's: **this is declaration territory,
not imperative-code territory**. You should say what kind of memory
you want, and the runtime should do it.

```ruby
class SupportAgent < GenModel
  memory :conversation, strategy: :sliding_window, size: 20, scope: :session
  memory :user_facts,   strategy: :semantic, top_k: 5,       scope: :support_team
  memory :activity_log, strategy: :log,                       scope: :global
end
```

## Strategies (v1)

Three strategies cover the useful shapes. A fourth (`:kv` for
structured state) is deferred pending a real use case.

| Strategy          | What it stores                        | How it's retrieved                              |
|-------------------|---------------------------------------|-------------------------------------------------|
| `:sliding_window` | The last N turns (user + assistant)   | Verbatim, in-order                              |
| `:semantic`       | Embedded chunks with metadata         | Top-K nearest to a query (default: current user input) |
| `:log`            | Every turn, append-only               | Not auto-injected; available to tools/exports   |

`:log` is the storage backbone — `:sliding_window` is `:log` with a
truncating reader, and `:semantic` is `:log` plus an embedding
pipeline. Building all three on top of a single append-only log keeps
the data model simple and makes retention/governance uniform.

## Read path: pre-injection

Before generation, the runtime resolves each declared memory into a
block and injects it into the system/context. The gen author doesn't
call anything — memory is *already there* by the time the model turn
starts.

Rendered shape (illustrative):

```
## Memory
### conversation (last 20 turns)
[2026-04-10 14:02] user: ...
[2026-04-10 14:02] assistant: ...
...
### user_facts (5 most relevant)
- User prefers email over Slack (retrieved 2026-04-08)
- Timezone: America/Los_Angeles (retrieved 2026-03-19)
...
```

Retrieval happens fresh per turn, so semantic-memory queries can use
the current user input as the query automatically. Explicit overrides
(`memory :foo, query: :last_signal_value`) come in a later iteration.

## Write path: retro/memory agent

This is the novel part. The output of every gen run already lands in
the trace — we have the full record (input, tool calls, output,
signals). Rather than auto-save the output or tie memory to signals,
**a second gen — the memory agent — runs after the primary gen and
writes to memory based on what it read**.

```ruby
class SupportMemoryAgent < GenModel
  system :support_memory
  returns MemoryWrites
  mode :retro         # runs AFTER the primary gen, reads its trace

  reads_trace_of :support_agent

  # MemoryWrites contains entries like:
  #   { memory: "user_facts", content: "User prefers email" }
  #   { memory: "conversation", content: "<last turn>" }
end

class SupportAgent < GenModel
  memory :conversation, strategy: :sliding_window, size: 20
  memory :user_facts,   strategy: :semantic, top_k: 5

  write_memory_via :support_memory_agent
end
```

Benefits of this shape:

- **Separation of "do the task" from "decide what to remember."** The
  primary agent stays focused. A different gen owns retention policy.
- **Composable.** Different memory agents for different flavors of
  recall. One gen can have several (e.g. a high-signal fact extractor
  + a conversational logger + an incident summarizer).
- **Uses Cambium's own primitives.** The memory agent has a schema,
  system prompt, validation, and trace — same ergonomics as everything
  else. Debuggable.
- **Retroactive edits possible.** A memory agent can look at the whole
  run, not just the last turn, and decide "this was important" or
  "actually, unremember what we said two turns ago."

The trivial default (for gens that don't declare a memory agent) is
append-the-turn for `:sliding_window`/`:log`, no-op for `:semantic`.
Explicit memory agents are the common path.

## Scope (decided)

Three scope kinds, covering all the cases `:user` / `:gen` would have covered without the ceremony:

- `:session` — a single conversation / run-chain.
- `:global`  — workspace-wide.
- **Named pools** (e.g. `:support_team`, `:security_agent`) — a shared memory bucket addressable by name. Any number of gens can opt in by referencing the pool's symbol.

`:user` is handled by `:session` + `keyed_by: :user_id`. `:gen` is handled by a named pool the gen opts into alone. Simpler grammar, same coverage.

### Named pools are file-declared

Each named pool is defined in its own file under `packages/cambium/app/memory_pools/<name>.pool.rb`, mirroring the one-file-per-object invariant Cambium uses everywhere else (tools → `.tool.json`+`.tool.ts`, policies → `.policy.rb`, systems → `.system.md`). The filename is the pool name; the body sets the slots with flat directives, matching the `.policy.rb` shape from RED-214:

```ruby
# packages/cambium/app/memory_pools/support_team.pool.rb
strategy :semantic
embed    "omlx:bge-small-en"    # literal, or an alias symbol: `:embedding` (RED-237)
keyed_by :team_id
```

A gen references the pool by symbol:

```ruby
memory :user_facts, scope: :support_team, top_k: 5
```

The pool is authoritative on `strategy`, `embed`, and `keyed_by` — those are the shared parts. The gen can only add reader knobs (`size`, `top_k`). Setting any pool-owned slot at the gen's call site is a compile error; if you need a different strategy or embed, define a new pool file.

**No inline-on-first-use.** A gen referencing an undeclared pool is a compile-time error that names the missing pool and lists where the compiler looked. This keeps pool definitions discoverable and avoids ordering-dependent shape drift.

**Out of scope for v1 pool files** (parsed in a later phase or never):
- `backend` — phase 2 implicitly uses sqlite-vec for every pool; add the directive when a second backend exists.
- `retain` — governance (TTL/caps) lands in the separate follow-up ticket.

### Keying: `keyed_by: <symbol>` (decided)

Of the three options considered, the declarative one wins: `memory :user_facts, keyed_by: :user_id` (or the same on the pool declaration). At run time the caller must provide the named key or the runner errors. Matches the rest of Cambium — declarative, checkable, doesn't rely on ambient state.

## Backend (decided): sqlite-vec

**v1 backend: [`sqlite-vec`](https://github.com/asg017/sqlite-vec).** One SQLite file per memory bucket, at `runs/memory/<scope>/<key>/<name>.sqlite`. The same file holds both the append-only log (ordinary SQLite rows) and the vector index (sqlite-vec virtual table). Benefits:

- **One-file ops.** `cp`, `rm`, `sqlite3 inspect` — debugging is trivial.
- **Active maintenance.** sqlite-vec replaces the abandoned sqlite-vss, same author.
- **Small surface.** ~1 MB extension, no daemon, no port, no secrets.
- **Single storage format** for both `:log`/`:sliding_window` (scan) and `:semantic` (vector search) — the strategy is a reader concern, not a storage concern.

**Embedding model:** configured via the `embed:` slot, resolved through the RED-237 model-alias mechanism. The provider-prefix string form (`embed: "omlx:bge-small-en"`) and the alias form (`embed: :embedding`) both work; pool declarations should prefer the alias so a workspace-wide model swap is a one-line change.

**Pluggable backends** (Redis, Postgres/pgvector, LanceDB, Pinecone, …) are explicitly out of scope for v1. The `MemoryBackend` interface will be narrow enough that a backend swap is a day's work when someone actually needs scale; we're not adding plugin machinery until there's a real second implementation to validate the abstraction against.

## Governance (post-RED-137 thinking)

Memory is the next attack surface after network egress. A malicious
gen — or a confused one — could exfiltrate private data cross-user or
hoard indefinitely. Design hooks to add in a follow-up ticket, not v1:

- **Retention.** `memory :foo, retain: "30d"` — hard TTL.
- **Cross-gen isolation.** By default, memory is scoped to the gen
  that declared it. Sharing across gens is explicit:
  `memory :user_facts, shared_with: [:support_agent, :billing_agent]`.
- **Allow/denylist.** A workspace-level policy can cap memory size,
  ban `:global` scope for untrusted gens, require `keyed_by: :user_id`
  for anything user-personal.
- **Trace events.** `memory.read`, `memory.wrote`, `memory.pruned` —
  so audits can show what each run remembered.

These are the memory analog of RED-137's `tool.permission.denied` and
`tool.budget.exceeded`. Worth its own ticket once the shape is settled.

## What's out of scope for v1

- `:kv` strategy (structured state). Defer until a concrete use case.
- Retroactive memory editing (delete/update prior entries). Append-only
  is simpler and lets us defer the governance questions.
- Memory-to-memory references (one memory's retrieval feeding another
  memory's query). Tempting, complicated, premature.
- Cross-workspace / multi-tenant memory. v1 is single-workspace.
- Governance (retention, isolation, allowlists) — separate ticket.

## Locked decisions (2026-04-16)

The open questions from the original draft are resolved. Captured here so anyone picking up implementation doesn't have to re-litigate.

1. **Scope set:** `:session`, `:global`, and **named pools** (file-declared under `app/memory_pools/<name>.pool.rb`). `:user` and `:gen` are handled by `:session`+`keyed_by:` and named pools respectively — no separate keywords.
2. **Key declaration:** `keyed_by: :symbol` on the gen or pool; caller-passes at run time; runner errors clearly when the key is missing.
3. **Embedding model:** configurable per pool via `embed:`, accepting either a provider-prefix string (`"omlx:bge-small-en"`) or a RED-237 model alias (`:embedding`). Aliases preferred in shared pool declarations so workspace-wide model swaps stay one-line.
4. **Trace events:** three events, present tense, consistent with `ToolCall`/`Generate`:
   - `memory.read`  — `{ strategy, query?, k?, hits: [{id, score?}] }`
   - `memory.write` — `{ entry_id, bytes }`
   - `memory.prune` — `{ reason: "ttl" | "cap", count }`
5. **Retro-agent timing:** **sync/blocking for v1.** The memory agent runs between primary output and return, so the trace has one clean story and there are no read-before-write races inside tight `:session` loops. An `:async` opt-in knob is explicitly deferred; if memory-agent latency becomes a real problem, traces will show it and we'll revisit.
6. **Backend:** `sqlite-vec`, one file per bucket. Pluggable backends deferred.

## Implementation phases

1. ~~Design note reviewed and open questions answered.~~ ✅ (2026-04-16)
2. ~~IR shape + Ruby DSL parsing for `memory :name, ...`, `write_memory_via :agent_name`, `reads_trace_of :agent_name`, and `app/memory_pools/<name>.pool.rb`. The TS runner tolerates the new IR fields but does not execute them yet.~~ ✅ (2026-04-16)
3. `sqlite-vec` backend skeleton + `:sliding_window` + `:log` strategies (read path + write path + three trace events).
4. Retro-agent runtime wiring (`mode :retro`, `reads_trace_of`, sync-only).
5. `:semantic` strategy (embedding via `embed:`, coordinated with RED-237 alias resolution).
6. Governance (separate ticket): retention, cross-pool isolation, workspace policy.

### Phase 2 artifacts (landed)

- `ruby/cambium/runtime.rb` — `MemoryPool`, `MemoryPoolBuilder`, gen-side `memory`/`write_memory_via`/`reads_trace_of` DSL, plus `_cambium_memory_pool_search_dirs`.
- `ruby/cambium/compile.rb` — resolves named pools, enforces pool-owned-slot exclusivity, emits `policies.memory` (flattened entries), `policies.memory_pools` (only the pools actually referenced), `policies.memory_write_via`, and top-level `reads_trace_of`.
- `packages/cambium/app/memory_pools/support_team.pool.rb` — first reference pool.
- `packages/cambium/tests/compile_memory.test.ts` — 12 compile-shell tests covering valid decls, pool resolution, pool-owned-slot conflicts, missing-pool errors, bad pool names (path-traversal guard), missing-strategy errors, missing-embed errors, unknown opts, invalid strategy symbols, and retro-mode pass-through.

### IR shape emitted by phase 2

```json
{
  "policies": {
    "memory": [
      { "name": "conversation", "scope": "session", "strategy": "sliding_window", "size": 20 },
      { "name": "user_facts",   "scope": "support_team", "strategy": "semantic",
        "embed": "omlx:bge-small-en", "keyed_by": "team_id", "top_k": 5 }
    ],
    "memory_pools": {
      "support_team": { "strategy": "semantic", "embed": "omlx:bge-small-en", "keyed_by": "team_id" }
    },
    "memory_write_via": "support_memory_agent"
  },
  "mode": "retro",
  "reads_trace_of": "support_agent"
}
```

Only pools actually referenced by this gen are inlined under `policies.memory_pools` — the runner doesn't need to know about pool files it isn't going to touch.
