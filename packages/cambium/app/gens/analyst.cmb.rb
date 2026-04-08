# Cambium reference implementation (v0.1)
#
# Goal: demonstrate DSL -> IR -> runner -> TypeBox contracts -> validate/repair -> trace.

class Analyst < GenModel
  # Local-first by convention
  model "ollama:llama3:70b"
  temperature 0.2
  max_tokens 1200

  # Contracts (TypeBox -> JSON Schema at runtime)
  returns AnalysisReport

  # Tools are declared; runner decides when to call them (v0.1)
  uses :calculator
  corrects :math

  constrain :tone, to: :professional

  def analyze(document)
    generate "analyze incident transcript" do
      with context: document
      returns AnalysisReport
    end
  end
end
