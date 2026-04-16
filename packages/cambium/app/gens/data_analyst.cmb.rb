# Agentic mode example: the model calls tools during generation.
# Instead of signals/triggers computing avg post-generation,
# the model itself calls the calculator tool mid-generation.

class DataAnalyst < GenModel
  model :default
  system :data_analyst
  mode :agentic
  temperature 0.2
  max_tokens 1200

  returns AnalysisReport
  uses :calculator

  constrain :budget, max_tool_calls: 10

  def analyze(document)
    generate "analyze this document, use the calculator tool for any computations" do
      with context: document
      returns AnalysisReport
    end
  end
end
