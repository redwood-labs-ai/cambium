# Primitive: mode

**Doc ID:** gen-dsl/primitive/mode

## Purpose
Control the execution strategy for `generate` blocks.

- **Default (no mode):** `generate` is a single LLM call. Tools fire post-generation via signals/triggers.
- **`mode :agentic`:** multi-turn tool-use loop — the model calls tools during generation, receives results, and iterates until it produces the final output.
- **`mode :retro`:** this gen is a *memory agent* (RED-215) that runs AFTER a primary gen, reads its trace via `reads_trace_of`, and returns `MemoryWrites` for the primary's memory slots. Not invoked directly by a user — the runner spawns it as a subprocess when a primary declares `writes_memory_via :ThisClass`.

## Semantics (normative)
- `mode :agentic` MUST enable multi-turn tool-use via the OpenAI function-calling protocol.
- Tool calls during generation MUST respect the `uses` allowlist (deny-by-default).
- Every tool call MUST be logged in the trace with typed I/O and timing.
- The loop MUST terminate when the model produces content without tool calls (final output).
- The loop MUST be capped by `constrain :budget, max_tool_calls: N` (default: 20).
- The loop MUST NOT re-execute an exact-duplicate tool call (same tool name + same
  arguments) that already returned this run (RED-184). The re-dispatch is skipped and
  the model is handed a `duplicate: true` result telling it the call already ran;
  the call still counts against `max_tool_calls`, so this is a faster trigger for
  the budget backstop, not a replacement for it. Only successful dispatches are
  remembered — a call that threw MUST still be retriable, since the throw describes
  that attempt and not the call. Exact match only — a duplicate `read_file` after a
  write to that file returns the pre-write result.
- The final output goes through the normal validate/repair pipeline.
- The user prompt MUST be split into a cacheable prefix (DOCUMENT + non-primary
  context sections) and the per-call instruction, whenever the prefix clears
  `MIN_CACHE_PREFIX_CHARS` (~4 KB) (#228). The agentic prefix deliberately does
  **not** carry the single-turn path's `OUTPUT_JSON_TEMPLATE` block: the
  pre-#228 agentic prompt never had one, and #228 is a cost fix that adds no
  prompt content (DEC-008). Unlike the single-turn path, the split is
  **size-gated only** — `grounded_in` is not required, because an agentic prefix
  is re-sent on every turn and the cache write pays for itself from turn 2 onward
  (a gen that answers on turn 1 pays the write without a read). Providers that
  cannot mark a prompt-cache breakpoint never see the split:
  the runner folds the prefix back into the first user message as
  `<prompt>\n\n<prefix>`, so oMLX/Ollama requests are unchanged.
- On Anthropic the loop MUST request the API's **automatic** cache breakpoint (a
  top-level `cache_control` field) rather than placing a rotating marker itself,
  and MUST keep explicit block-level markers at three or fewer — `system`,
  `tools[last]`, and the prefix. Anthropic's ceiling is four, the automatic
  breakpoint consumes one, and a fifth explicit marker is an HTTP 400 on every
  turn. See [[N - Model Identifiers]] § Anthropic prompt caching.
- A fan-out MUST NOT prewarm an agentic branch (#228). Prewarm fires through the
  single-turn path, which sends no tools; Anthropic builds cache prefixes
  `tools` → `system` → `messages`, so a tools-less warm-up diverges at the first
  level and writes an entry the branch can never read.

## Example

```ruby
class DataAnalyst < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :data_analyst
  mode :agentic

  returns AnalysisReport
  uses :calculator

  constrain :budget, max_tool_calls: 10

  def analyze(document)
    generate "analyze this document, use the calculator for computations" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

## How it works
1. Model receives the task + tool definitions (OpenAI format)
2. Model responds with tool calls (e.g., `calculator({ operation: "avg", operands: [...] })`)
3. Runtime executes tool calls, returns results to the model. An exact repeat of an
   earlier call that succeeded (same tool + same args) is answered from memory instead
   of re-dispatched (RED-184) — the reply says so and the model is told to change tack
   or answer. A repeat of a call that failed is dispatched again.
4. Model iterates until it produces the final JSON output
5. Final output goes through validate → repair → correctors → signals/triggers

The shared head of the first user message (document + context sections — no
output template, per DEC-008) is assembled once, by the same helpers the
single-turn path uses, and re-sent verbatim on every turn — so on a
cache-capable provider it is written once and read on turns 2..N instead of
re-billed each time (#228).

## When to use which mode

| Mode | Use case | Tools | Cost |
|------|----------|-------|------|
| Default (no mode) | Data extraction, analysis | Post-generation via signals/triggers | 1 LLM call + signal-driven tools |
| `mode :agentic` | Multi-step tasks, coding, research | Model calls tools mid-generation | 2+ LLM calls, model decides when |
| `mode :retro` | Memory agent — decide what to remember after a primary gen | No tools (memory writes only) | 1 LLM call per primary run, best-effort |

## Retro-mode semantics (RED-215)

`mode :retro` flags a class as a memory agent. The framework, not the user, invokes it:

- The agent MUST declare `reads_trace_of :primary_class` (names the gen whose trace this agent reads).
- The agent MUST declare `returns MemoryWrites` (the structured write list the primary applies).
- The agent's entry method is always `remember(ctx)` — Cambium's `ActiveJob#perform`. The `ctx` argument is a JSON string with `primary_input`, `primary_output`, and `primary_trace`.
- A retro agent's own `memory :...` decls are skipped — memory machinery is suppressed when `ir.mode === 'retro'` to prevent recursion.
- Retro-agent failures never fail the primary run (best-effort writes). The primary's output is the contract.

Example:

```ruby
class SupportMemoryAgent < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :support_memory_agent
  returns MemoryWrites
  mode :retro
  reads_trace_of :support_agent

  def remember(ctx)
    generate <<~PROMPT do
      <RUN_DATA>
      #{ctx}
      </RUN_DATA>

      Based on the run data above, return a MemoryWrites object.
    PROMPT
      returns MemoryWrites
    end
  end
end
```

On the primary side: `writes_memory_via :SupportMemoryAgent`.

## Trace output

```json
{
  "type": "AgenticTurn",
  "ms": 12074,
  "ok": true,
  "meta": {
    "turn": 1,
    "tool_calls": [{ "name": "calculator", "args": "{...}" }],
    "results": [{ "tool": "calculator", "output": { "value": 179.56 } }],
    "usage": { "prompt_tokens": 500, "completion_tokens": 361, "total_tokens": 861 }
  }
}
```

## Composability
- **With validate/repair**: final output is validated and repaired like any other generate
- **With correctors**: run after the agentic loop completes
- **With compound review**: review checks the final output
- **With grounding**: citation enforcement on the final output
- **With signals/triggers**: fire on the final output (in addition to in-loop tool calls)

## See also
- [[P - uses (tools)]]
- [[P - constrain]]
- [[P - Memory]]
- [[N - Agentic Transactions]]
- [[N - Model Identifiers]] — Anthropic prompt caching, agentic breakpoint allocation
- [[N - Orchestration Layer]] — fan-out cache prewarm (and why it skips agentic branches)
- [[C - Trace (observability)]]
