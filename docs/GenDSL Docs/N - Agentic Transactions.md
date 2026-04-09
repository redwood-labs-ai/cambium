# Note: Agentic Transactions

**Doc ID:** gen-dsl/note/agentic-transactions

## Purpose
Extend Cambium beyond structured data extraction into autonomous agent workflows — coding, operations, research — while preserving the contract-driven, auditable execution model that makes Cambium different from "a pile of agent scripts."

## The core tension
Cambium v0 is "produce this exact JSON shape." An engineering agent can't work that way — it needs to read files, make decisions, write code, run tests. You can't pre-define every field it will touch.

The resolution: **the transaction contract doesn't constrain what the agent does, it defines what "done" looks like.**

`returns AnalysisReport` = produce this JSON shape.
`returns EngineeringTransaction` = produce these artifacts that prove the work is complete.

The autonomy is in the middle. The contract is at the boundary.

---

## Example: Linear ticket → PR

### The flow
1. Linear ticket created → webhook to Cambium app
2. `Engineer#implement(ticket)` — agentic loop with tool access
3. Transaction output: PR, files modified, summary, checks passed
4. `CodeReviewer#review(transaction)` — second agent reviews the work
5. If approved → merge. If rejected → signal back to engineer for another pass.

### The engineer

```ruby
class Engineer < GenModel
  model "claude:sonnet"
  system :engineer

  # The transaction contract: what "done" looks like
  returns EngineeringTransaction

  # Tools the agent can use (deny-by-default)
  uses :file_read, :file_write, :git, :test_runner, :linear

  # Deterministic post-checks (not LLM judgment)
  corrects :lint, :tests

  # Post-transaction review by another agent
  constrain :compound, strategy: :review

  def implement(ticket)
    generate "implement the changes described in this ticket" do
      with context: ticket
      with repo: "github.com/org/repo"
      returns EngineeringTransaction
    end
  end
end
```

### The transaction schema

```typescript
export const EngineeringTransaction = Type.Object(
  {
    pr_url: Type.String(),
    branch: Type.String(),
    files_modified: Type.Array(
      Type.Object({
        path: Type.String(),
        action: Type.Union([
          Type.Literal('created'),
          Type.Literal('modified'),
          Type.Literal('deleted'),
        ]),
      })
    ),
    summary: Type.String(),
    checks: Type.Object({
      lint_passed: Type.Boolean(),
      tests_passed: Type.Boolean(),
      test_count: Type.Number(),
    }),
  },
  { additionalProperties: false, $id: 'EngineeringTransaction' }
)
```

### The reviewer

```ruby
class CodeReviewer < GenModel
  model "claude:opus"
  system :code_reviewer

  returns ReviewVerdict

  uses :file_read, :git_diff

  constrain :tone, to: :thorough

  def review(transaction)
    generate "review this engineering transaction for correctness and quality" do
      with context: transaction
      returns ReviewVerdict
    end
  end
end
```

### The verdict schema

```typescript
export const ReviewVerdict = Type.Object(
  {
    approved: Type.Boolean(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    concerns: Type.Array(
      Type.Object({
        severity: Type.Union([
          Type.Literal('blocking'),
          Type.Literal('suggestion'),
          Type.Literal('nit'),
        ]),
        file: Type.String(),
        message: Type.String(),
      })
    ),
    summary: Type.String(),
  },
  { additionalProperties: false, $id: 'ReviewVerdict' }
)
```

---

## What makes this Cambium, not "just another agent framework"

### Contracts at the boundary
The engineer has autonomy inside the loop. But it must produce a valid `EngineeringTransaction`. The reviewer must produce a valid `ReviewVerdict`. Both outputs are typed, validated, repairable. Downstream systems can consume them safely.

### Deny-by-default tools
`uses :file_read, :file_write, :git, :test_runner` — the agent can only touch declared tools. No undeclared file access, no secret network calls. Every tool call is logged in the trace with typed I/O.

### Deterministic correctors
`corrects :lint, :tests` — after the agent says "I'm done," deterministic checks verify lint passes and tests pass. These are not LLM judgment calls. They're programs checking programs.

### Composable review
The review is itself a governed GenModel with its own contract. Two agents, two traces, both auditable. The reviewer's output is structured — not a free-text "LGTM" but a typed verdict with severity-tagged concerns.

### Signals bridge agents
The reviewer's output feeds back through signals:

```ruby
# In the orchestrator
extract :approved, type: :boolean, path: "approved"
extract :blocking_concerns, type: :array, path: "concerns"

on :approved do
  tool :git_merge, target: "merge_result"
end

on :blocking_concerns do
  tool :engineer_resubmit, target: "resubmit_result"
end
```

The model never decides to merge. The signal/trigger system observes the verdict and acts deterministically. "LLMs propose; programs dispose."

### Full trace
Every step of the engineering loop — every file read, every test run, every review concern — is captured in the trace. When something goes wrong in production, you open the trace and see exactly what the agent did, what it changed, what was reviewed, and why it was approved.

---

## The `generate` block as an agentic loop

In v0, `generate` is a single LLM call. For agentic transactions, `generate` becomes a **multi-turn loop**:

1. Model receives the task + tool descriptions
2. Model emits tool calls (file_read, file_write, etc.)
3. Runtime executes tool calls, returns results
4. Model iterates until it believes the transaction is fulfilled
5. Model emits the final transaction output
6. Runtime validates against schema
7. Correctors run (lint, tests)
8. If invalid → repair loop with specific feedback
9. If valid → review agent evaluates

The key: this loop is **still governed by the same primitives.** `uses` controls what tools are available. `returns` defines what "done" means. `corrects` adds deterministic checks. The trace captures every turn.

---

## Multi-agent composition patterns

### Sequential pipeline
```
Engineer → CodeReviewer → (merge or rework)
```

### Parallel consensus
```
Engineer×2 → Consensus → CodeReviewer
```
Two engineers implement independently. Consensus catches different approaches. Reviewer evaluates the merged result.

### Escalation chain
```
Engineer → CodeReviewer → (if blocking) → SeniorReviewer
```
Signals drive escalation. Each agent has its own model, system prompt, and contract.

### Self-review
```ruby
constrain :compound, strategy: :review
```
The same model reviews its own work. Cheaper, catches obvious mistakes. Can be combined with external review.

---

## Context enrichment: the `enrich` primitive

### The problem
Real-world agent inputs are messy and large. An incident response agent might receive 50,000 tokens of raw Datadog logs alongside a few latency numbers. The latency numbers go straight into the schema. But the raw logs need to be **digested** before the main agent can use them — they won't fit in a local model's context window, and even if they did, they'd drown the signal.

### The solution
`enrich` is a pre-generation primitive that delegates a chunk of context to a sub-agent, replaces the raw data with the sub-agent's typed output, and then hands the cleaned context to the main `generate` step.

```
Enrich (sub-agent) → Generate → Validate → Review → Correct → Triggers
```

### Example: incident with Datadog logs

```ruby
class IncidentAnalyzer < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst

  returns IncidentReport

  uses :calculator
  corrects :math

  # Pre-generate: summarize raw logs before the main generation.
  # The sub-agent runs its own transaction (typed, validated, traced).
  enrich :datadog_logs do
    agent :LogSummarizer, method: :summarize
  end

  extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"

  on :latency_ms do
    tool :calculator, operation: "avg", target: "metrics.avg_latency_ms"
  end

  def analyze(incident)
    generate "analyze this incident" do
      with context: incident    # includes enriched logs summary, not raw logs
      returns IncidentReport
    end
  end
end
```

### The summarizer sub-agent

```ruby
class LogSummarizer < GenModel
  model "claude:haiku"      # can use a different model, maybe one with larger context
  system :summarizer

  returns LogSummary         # { key_events, error_patterns, timeline, entry_count }

  constrain :tone, to: :concise

  def summarize(logs)
    generate "extract key events and error patterns from these logs" do
      with context: logs
      returns LogSummary
    end
  end
end
```

### The schema

```typescript
export const LogSummary = Type.Object(
  {
    key_events: Type.Array(
      Type.Object({
        timestamp: Type.String(),
        message: Type.String(),
        severity: Type.Union([
          Type.Literal('info'),
          Type.Literal('warning'),
          Type.Literal('error'),
          Type.Literal('critical'),
        ]),
      })
    ),
    error_patterns: Type.Array(
      Type.Object({
        pattern: Type.String(),
        count: Type.Number(),
        first_seen: Type.String(),
        last_seen: Type.String(),
      })
    ),
    timeline_summary: Type.String(),
    total_entries: Type.Number(),
  },
  { additionalProperties: false, $id: 'LogSummary' }
)
```

### How `enrich` works

1. Before `generate` runs, the runtime checks for `enrich` declarations
2. For each enrichment, it extracts the named field from the context (e.g., `context.datadog_logs`)
3. It spins up the sub-agent as a full Cambium transaction — own schema, own validation, own repair loop, own trace
4. The sub-agent's validated output **replaces** the raw data in the context
5. The parent's `generate` step receives clean, typed, digested context

### Why this matters

**Token economics.** 50k tokens of raw logs → 500 tokens of `LogSummary`. The parent agent gets better signal at lower cost. The enrichment agent can run on a model with a larger context window (or chunk the logs across multiple calls).

**Composability.** Multiple enrichments compose:

```ruby
enrich :datadog_logs do
  agent :LogSummarizer, method: :summarize
end

enrich :slack_thread do
  agent :ThreadSummarizer, method: :summarize
end

enrich :pagerduty_timeline do
  agent :TimelineSummarizer, method: :summarize
end
```

All run before generate, all inject typed digests. The parent agent gets a clean context bundle.

**Auditability.** Each enrichment is its own traced sub-transaction. The parent trace references it. You can see exactly what the summarizer extracted and what was excluded. If the final analysis is wrong, you can trace back to whether the enrichment dropped critical information.

**Model flexibility.** The enrichment agent can use a different model than the parent. A large-context model (Claude, GPT-4) digests the raw logs. A fast local model (Qwen 27B) does the analysis on the clean context. Right model for the right job.

### Signal-triggered enrichment (alternative pattern)

Instead of always enriching, use signals to enrich conditionally:

```ruby
extract :log_count, type: :number, path: "context.datadog_logs.length"

on :log_count do |count|
  if count > 50
    agent :LogSummarizer, method: :summarize, target: "context.datadog_logs"
  end
end
```

Small log sets pass through directly. Large ones get summarized. The threshold is authored by the developer, not decided by the model.

---

## Implementation considerations

### Agentic loop execution
The runner needs a new execution mode for `generate` blocks that declares tools. Instead of a single `generateText` call, it enters a tool-use loop (OpenAI function-calling or Anthropic tool-use protocol). Each turn is a trace step.

### Multi-agent orchestration
An orchestrator GenModel that composes other GenModels. The `generate` block calls sub-agents and collects their outputs. This could be a new primitive (`compose`) or just a tool (`tool :run_agent, agent: "CodeReviewer"`).

### State persistence
Agentic transactions may take minutes or hours. The state store needs to persist beyond a single run — file-backed or database-backed, resumable from the last checkpoint.

### Cost controls
Agentic loops can run up token counts. Constraints should support budgets:
```ruby
constrain :budget, max_tokens: 50_000
constrain :budget, max_tool_calls: 100
constrain :budget, max_duration: "5m"
```

---

## See also
- [[C - Signals, State, and Triggers]]
- [[P - Compound Generation]]
- [[P - uses (tools)]]
- [[S - Tool Permissions & Sandboxing]]
- [[C - Trace (observability)]]
