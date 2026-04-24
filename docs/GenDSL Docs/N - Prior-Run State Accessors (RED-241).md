## Note: Prior-Run State Accessors

**Doc ID:** gen-dsl/note/prior-run-state
**Status:** Settled — no new primitive (RED-241)
**Last edited:** 2026-04-21

---

## Purpose

Originally filed as part of RED-238 with proposed DSL shapes like:

```ruby
memory :x, strategy: :semantic, query: :last_signal_value
memory :x, strategy: :semantic, query: :output_field(:name)
```

Both shapes imply "use state from a prior run as input to *this* run" — a load-bearing primitive that RED-238's review flagged as too big to back-door through a memory-specific query keyword. RED-241 exists to settle whether Cambium needs a dedicated prior-run-state primitive, or whether existing machinery composes to handle the use cases.

This note resolves the question. **Conclusion: no new primitive is needed.** The existing memory + retro-agent machinery, combined with RED-273's `scope: :schedule`, covers every forcing case. The 20% edge case (dynamic prior-run queries where *this* run's input determines *which* prior run's state to read) has no real-world grounding and is deferred without a primitive.

---

## The use cases (enumerated)

### Case 1: "What did this gen output last time?"

Forcing example: a scheduled digest gen that wants to start today's summary with "yesterday's report said X."

**Solves via existing machinery:**

```ruby
class MorningDigest < Cambium::GenModel
  cron :daily, at: "9:00"

  memory :yesterday, scope: :schedule, strategy: :sliding_window, size: 1
  write_memory_via :DigestMemoryAgent   # retro agent writes output

  def analyze(input)
    # ctx.memory[:yesterday] is auto-injected into the system prompt
    # as the last entry's content.
    generate "today's digest, noting continuity from yesterday's" do
      with context: input
      returns DigestReport
    end
  end
end
```

`scope: :schedule` (RED-273) gives the bucket per-schedule identity. `:sliding_window, size: 1` stores exactly one entry. The retro agent writes the run's output. Next fire reads the single most recent entry. No primitive needed.

### Case 2: "What was this gen's signal `:user_intent` last time?"

Forcing example: a chat agent that remembers the user's last declared intent across sessions.

**Solves via existing machinery:**

```ruby
class ChatAgent < Cambium::GenModel
  memory :last_intent, scope: :session, strategy: :sliding_window, size: 1
  write_memory_via :IntentMemoryAgent

  def respond(input)
    # ctx.memory[:last_intent] injected into prompt.
    generate "continue the conversation" do
      with context: input
      returns Response
    end

    extract :user_intent, from: :output
  end
end

# app/gens/intent_memory_agent.cmb.rb
class IntentMemoryAgent < Cambium::GenModel
  mode :retro
  reads_trace_of :ChatAgent
  returns MemoryWrites

  def remember(ctx)
    # Retro agent reads the primary's trace, extracts the signal,
    # writes to the memory slot.
    generate "extract the user_intent signal and write it to :last_intent" do
      with trace: ctx.trace_summary
      returns MemoryWrites
    end
  end
end
```

Retro agent has full access to the primary's trace via `reads_trace_of`. It can pick any signal value and write it to any memory slot (RED-215 phase 4). No primitive needed.

### Case 3: "Use last scheduled run's output as THIS run's context"

Forcing example: weekly audit gen reads last week's top findings to seed this week's scan.

**Solves via existing machinery:**

```ruby
class WeeklyAudit < Cambium::GenModel
  cron :weekly
  memory :prior_findings, scope: :schedule, strategy: :sliding_window, size: 1
  write_memory_via :AuditMemoryAgent
  # ... same pattern as case 1
end
```

Same shape as case 1. `scope: :schedule` keys the bucket per-schedule-id so different schedules don't collide.

### Case 4: "Aggregate the last N days of signals"

Forcing example: trend-detection gen needs the last 7 days of `pattern_severity` signals.

**Solves via existing machinery:**

```ruby
class TrendDetector < Cambium::GenModel
  cron :daily
  memory :severity_log, scope: :schedule, strategy: :sliding_window, size: 7
  write_memory_via :TrendMemoryAgent
end
```

`size: 7` gives the last 7 entries. The gen sees them concatenated in the prompt. Retro agent writes one entry per day with the severity value.

### Case 5 (the 20% edge case): "Dynamic prior-run query"

Forcing example: "find the prior run whose `:query_intent` was most similar to this run's input, and use its output as context."

This one *does not* collapse cleanly. It requires inter-slot query composition (query slot A using contents of slot B's latest entry), which isn't a primitive Cambium has.

**Deferred without a primitive because:**

1. **No real-world forcing case has surfaced.** Curator, and hypothetical scheduled gens all fit cases 1–4.
2. **The workaround is cheap when needed:** retro agent + an enrichment that does the semantic lookup explicitly. Verbose, but works.
3. **Adding it as a primitive would commit to a substantial design surface** (how does the query plan interact with memory strategies? what's the IR shape for "read A using B.latest as query"? observability on the composed query?). Not worth it without a real forcing case.

If a user hits this and the workaround hurts, file a new ticket with the concrete shape.

---

## Why no new primitive

### The six questions from the original ticket

1. **Where does prior-run state live?** In memory slots. Existing `:session` / `:global` / `:named_pool` / `:schedule` (RED-273) scopes cover every forcing case.
2. **Is this a general accessor, or does it collapse into memory?** Collapses. See cases 1–4.
3. **Scope alignment.** Pick the scope that matches the semantic — session for chat chains, schedule for cron'd gens, global for workspace-wide, named pool for shared-across-team.
4. **Contract of "last."** Whatever strategy you pick:
   - `:sliding_window` → last N chronologically.
   - `:semantic` → nearest-to-query by embedding (query is `ctx.input` by default, or RED-238's `query:` / `arg_field:` knobs).
   - `:log` → all entries in order.
5. **Failure modes (empty on first run).** Memory read returns nothing; no `## Memory` block is injected into the prompt; gen runs without prior context. Document the idiom: gens that *require* prior state should guard in their prompt ("If memory is empty, this is the first run — start a new thread"). Retro agents CAN seed the bucket before the first live run via a manual `cambium run` that just exercises the retro agent.
6. **Observability.** The existing `memory.read` trace step (RED-215) reports `strategy`, `scope`, `name`, `hits`, `bytes`, and for semantic reads the `query_preview` and `embed_model`. Already sufficient — a composed prior-run read through retro agents shows as `memory.read` of the bucket the agent wrote to, with the author's chosen strategy.

Every question has a settled answer in existing machinery. The primitive the original ticket sketched would duplicate what memory + retro agents already do.

### The Cambium-y argument

The existing composition — *write state via retro agent + read state via memory* — is exactly the kind of primitive-composition Rails-y frameworks aim for. Adding a dedicated "prior-run accessor" primitive would create a parallel story ("use memory for within-gen state; use prior-run accessors for across-run state") when the real story is cleaner: *memory is state; scope determines which runs see it*. One concept, not two.

---

## Rejected alternative

**Ship a dedicated prior-run-state primitive.** Proposed shapes from RED-238:

```ruby
memory :x, strategy: :semantic, query: :last_signal_value(:user_intent)
memory :x, strategy: :semantic, query: :output_field(:top_finding)
```

Rejected because:

- Every use case that motivated these shapes collapses into memory + retro agents as shown above.
- The syntax creates a second way to read state alongside existing memory — violates the "one obvious way to do it" principle.
- The edge case these shapes address (inter-slot query composition) doesn't have a real-world grounding; shipping speculatively would commit to a syntax we haven't stress-tested.

---

## Open questions (deferred without a primitive)

1. **Inter-slot query composition.** Case 5 above. No primitive; if forcing case surfaces, file a new ticket. Workaround: retro agent + explicit enrichment.
2. **Cross-gen state reads.** Gen A runs; gen B wants to read gen A's last signal. Solvable via shared named pool (`scope: :named_pool_name` on both gens' memory decls); not a prior-run question. Out of scope.

---

## Implementation

**None required.**

Every pattern in cases 1–4 works today with:

- `memory :<name>, scope: :schedule, ...` — requires RED-273 impl (`scope: :schedule` value + the runtime routing into `runs/memory/schedule/<id>/<name>.sqlite`).
- `memory :<name>, scope: :session, ...` — works today.
- `memory :<name>, scope: :global, ...` — works today.
- `memory :<name>, scope: :<pool_name>, ...` — works today.
- `write_memory_via :<AgentClass>` — works today (RED-215 phase 4).

RED-273's impl ticket carries the one dependency this note creates: `:schedule` as a valid `scope:` value, with the runtime bucket path. That's ~15 LOC of Ruby validator + ~40 LOC of TS memory-backend routing; already in scope for RED-273.

**This note produces no impl ticket of its own.** RED-241 closes as "settled — patterns documented, no new primitive."

---

## Out of scope

- **A new `prior_run` primitive.** Rejected.
- **`query:` keyword that reads from another slot.** RED-238 shipped the temporally-safe `query:` + `arg_field:` forms (literal string / arg field plucked from input). Cross-slot query composition not in scope; separate ticket if surfaces.
- **Automatic seeding of empty buckets on first run.** Document the idiom; don't build it.
- **Framework-level retro-agent guarantees** (e.g. "retro agent must fire for every primary run"). Already best-effort in RED-215 phase 4; unchanged.

---

## See also

- [[P - Memory]] — the machinery that covers every case
- [[N - Scheduled Gens (RED-273)]] — `scope: :schedule` makes cases 1, 3, 4 work for cron'd gens
- RED-215 phase 4 — retro agents and `write_memory_via`
- RED-238 — temporally-safe semantic memory query (shipped); original context for this ticket
- RED-273 — companion design note; scheduled gens forced the question that closes RED-241
