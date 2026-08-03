# Golden fixture for budget per_run: extended metrics (RED-Part1-extension).
# Exercises max_tokens, max_duration, and max_calls together in the new
# `budget` primitive so the corpus pins the compiled IR shape.

class BudgetPerRunExtended < GenModel
  model "omlx:stub"
  system "inline system prompt"

  returns do
    field :result, String
  end

  budget per_run: { max_tokens: 5000, max_duration: "5m", max_calls: 10 }

  def analyze(document)
    generate "analyze the document" do
      with context: document
    end
  end
end
