# Memory Primitive — Design Note

**Doc ID:** gen-dsl/primitives/memory
**Status:** Design draft (no implementation yet)
**Related:** [[P - extract (signals)]], [[C - Trace (observability)]], [[S - Tool Sandboxing (RED-137)]]

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
  memory :conversation, strategy: :sliding_window, size: 20
  memory :user_facts,   strategy: :semantic, top_k: 5
  memory :activity_log, strategy: :log
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

## Scope (open question)

Four natural scopes. V1 needs at least one; the shape needs to allow
the others later without a redesign.

- `:session` — a single conversation / run-chain.
- `:user`    — across all sessions for a user.
- `:gen`     — across all invocations of this gen, regardless of user.
- `:global`  — workspace-wide.

Key/isolation consideration: how is the memory bucket addressed?
Options:
1. Caller passes a `memory_key` into the run (e.g. `user_id`, `session_id`).
2. Runtime derives from ambient context (env vars, run metadata).
3. Gen declares what keys it wants (`memory :user_facts, keyed_by: :user_id`) and the runner validates they were provided.

Lean: **(3)** — declarative and checkable. Matches the rest of Cambium.

Scopes to support in v1: **TBD** (Steve is thinking about this).
Likely `:session` + `:user` as the minimum interesting pair.

## Backend (v1 baseline)

- Storage: local files under `runs/memory/<scope>/<key>/<name>.jsonl`
  for logs; a local vector DB (e.g. lancedb, usearch, or a sqlite-vss
  wrapper) for semantic.
- Pluggable later: Redis, Postgres, Pinecone, whatever. The interface
  is small enough that backend swaps shouldn't need DSL changes.

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

## Open questions

1. **Scope set for v1** — which of the four, in what order.
2. **Key declaration shape** — `keyed_by: :user_id` vs caller-passes vs ambient.
3. **Embedding model** — local (e.g. a small oMLX model) vs remote API.
   Local fits the opinionated stance; latency budget TBD.
4. **Trace shape** — memory reads/writes should appear alongside
   `ToolCall` in the trace. Exact event names to be settled during impl.
5. **Retro-agent trigger semantics** — does the memory agent run
   synchronously before the run returns, or async after? Sync is
   simpler and more debuggable; async is faster for the caller.
   Lean sync for v1.

## Implementation phases (once the design lands)

1. Design note (this doc) reviewed and open questions answered.
2. IR shape + Ruby DSL parsing for `memory :name, ...` and
   `write_memory_via :agent_name`.
3. Append-only log backend + `:sliding_window` + `:log` strategies.
4. Retro-agent runtime wiring (`mode :retro`, `reads_trace_of`).
5. `:semantic` backend with a chosen embedding model.
6. Governance (separate ticket): retention, isolation, policy.
