# Primitive: enrich

**Doc ID:** gen-dsl/primitive/enrich

## Purpose
Pre-generate context enrichment via sub-agent delegation. Raw context (logs, transcripts, large documents) is digested by a sub-agent into a typed summary before the main generation step. The original context is preserved; the enriched output is added alongside it.

## Semantics (normative)
- Enrichment MUST run before the `generate` step.
- The sub-agent MUST be a valid GenModel with its own `returns` schema.
- The sub-agent runs a full transaction: generate → validate → repair → trace.
- The original context field is NOT replaced. The enriched output is added as `<field>_enriched`.
- Enrichment failure is non-fatal: the parent continues with raw context.
- Enrichment token usage MUST be tracked in the trace.

## Example

```ruby
class Analyst < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  returns AnalysisReport

  enrich :document do
    agent :LogSummarizer, method: :summarize
  end

  def analyze(document)
    generate "analyze incident transcript" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

The sub-agent:

```ruby
class LogSummarizer < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :summarizer
  returns LogSummary

  def summarize(logs)
    generate "extract key events from these logs" do
      with context: logs
      returns LogSummary
    end
  end
end
```

## How it works
1. Before `generate` runs, the runtime checks for `enrich` declarations
2. For each enrichment, the sub-agent's `.cmb.rb` file is compiled to IR
3. The sub-agent runs a full generate/validate/repair cycle
4. The validated output is added to the parent context as `<field>_enriched`
5. The parent's `generate` step sees both the original document and the enriched analysis

## Composability
Multiple enrichments compose — each runs independently before generate:

```ruby
enrich :datadog_logs do
  agent :LogSummarizer, method: :summarize
end

enrich :slack_thread do
  agent :ThreadSummarizer, method: :summarize
end
```

## Token economics
Enrichment trades sub-agent tokens for parent efficiency. 50k tokens of raw logs → 500 tokens of typed LogSummary. The parent agent gets better signal at lower cost.

## Failure modes
- Sub-agent file not found → EnrichError in trace, parent continues with raw context
- Sub-agent schema validation fails after max repairs → EnrichFailed, parent continues
- Context field not found → EnrichSkipped

## See also
- [[N - Agentic Transactions]]
- [[D - Schemas (JSON Schema)]]
- [[C - Trace (observability)]]
- [[P - generate]]
