# Test-drive agent for RED-137 (sandboxing) + RED-214 (policy packs).
#
# Reads as a declaration of intent — "this is a research agent" —
# rather than a tuning panel. The :research_defaults pack owns the
# allowlist and the budget caps; this gen just declares which bundle
# to import. See app/policies/research_defaults.policy.rb.

class WebResearcher < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :web_researcher
  temperature 0.2
  max_tokens 800
  mode :agentic

  returns WebResearchResult

  uses :web_search

  security :research_defaults
  budget   :research_defaults

  def research(question)
    generate "research the question and return a short summary with sources" do
      with context: question
      returns WebResearchResult
    end
  end
end
