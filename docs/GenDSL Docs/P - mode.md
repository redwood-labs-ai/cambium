# Primitive: mode

**Doc ID:** gen-dsl/primitive/mode

## Purpose
Control the execution strategy for `generate` blocks. `mode :agentic` activates a multi-turn tool-use loop where the model calls tools during generation, receives results, and iterates until it produces the final output.

Without a mode declaration, `generate` is a single LLM call (the default). Tools fire post-generation via signals/triggers.

## Semantics (normative)
- `mode :agentic` MUST enable multi-turn tool-use via the OpenAI function-calling protocol.
- Tool calls during generation MUST respect the `uses` allowlist (deny-by-default).
- Every tool call MUST be logged in the trace with typed I/O and timing.
- The loop MUST terminate when the model produces content without tool calls (final output).
- The loop MUST be capped by `constrain :budget, max_tool_calls: N` (default: 20).
- The final output goes through the normal validate/repair pipeline.

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
3. Runtime executes tool calls, returns results to the model
4. Model iterates until it produces the final JSON output
5. Final output goes through validate → repair → correctors → signals/triggers

## When to use which mode

| Mode | Use case | Tools | Cost |
|------|----------|-------|------|
| Default (no mode) | Data extraction, analysis | Post-generation via signals/triggers | 1 LLM call + signal-driven tools |
| `mode :agentic` | Multi-step tasks, coding, research | Model calls tools mid-generation | 2+ LLM calls, model decides when |

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
- [[N - Agentic Transactions]]
- [[C - Trace (observability)]]
