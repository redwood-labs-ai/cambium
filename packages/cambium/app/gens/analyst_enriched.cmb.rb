# Analyst with enrichment: raw logs are summarized by a sub-agent
# before the main generation step.

class Analyst < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :analyst
  temperature 0.2
  max_tokens 1200

  returns AnalysisReport

  uses :calculator
  corrects :math

  constrain :tone, to: :professional
  constrain :compound, strategy: :review

  # Pre-generate: summarize the raw document's log section.
  # The LogSummarizer sub-agent produces a typed LogSummary,
  # which replaces the raw document before the main generate.
  enrich :document do
    agent :LogSummarizer, method: :summarize
  end

  extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"

  on :latency_ms do
    tool :calculator, operation: "avg", target: "metrics.avg_latency_ms"
  end

  def analyze(document)
    generate "analyze incident transcript" do
      with context: document
      returns AnalysisReport
    end
  end
end
