# Sub-agent: summarizes raw log entries into structured key events.
# Used as an enrichment agent by parent GenModels.

class LogSummarizer < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :summarizer
  temperature 0.1
  max_tokens 800

  returns LogSummary

  def summarize(logs)
    generate "extract key events and error patterns from these logs" do
      with context: logs
      returns LogSummary
    end
  end
end
