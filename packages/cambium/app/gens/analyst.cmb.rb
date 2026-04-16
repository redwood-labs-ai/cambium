# Cambium reference implementation (v0.2)
#
# Goal: demonstrate DSL -> IR -> runner -> TypeBox contracts -> validate/repair -> trace.
# v0.2: signals + triggers + compound generation constraints.

class Analyst < GenModel
  # Local-first by convention
  model :default
  system :analyst
  temperature 0.2
  max_tokens 1200

  # Contracts (TypeBox -> JSON Schema at runtime)
  returns AnalysisReport

  # Tools: declared, permissioned, logged
  uses :calculator
  corrects :math

  constrain :tone, to: :professional
  constrain :compound, strategy: :review

  # Grounding: enforce citations with verbatim quotes from the source document
  grounded_in :document, require_citations: true

  # Signals: extract typed data from the validated output
  extract :latency_ms, type: :number, path: "metrics.latency_ms_samples"

  # Triggers: deterministic actions when signals have values
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
