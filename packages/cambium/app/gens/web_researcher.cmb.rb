# Tiny RED-137 test-drive agent.
#
# Exercises the new security/budget surface end-to-end:
#   - security network: { allowlist: [...] }     -> gen-scoped egress policy
#   - budget per_tool: { web_search: { ... } }   -> per-tool call cap
#
# On each tool dispatch the runner should:
#   - build a ToolContext with a policy-bound fetch
#   - check the per-tool budget BEFORE dispatching (refuse past the cap)
#   - emit tool.permission.denied in the trace if egress is blocked
#   - emit tool.budget.exceeded in the trace if the cap trips

class WebResearcher < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :web_researcher
  temperature 0.2
  max_tokens 800
  mode :agentic

  returns WebResearchResult

  uses :web_search

  security network: {
    allowlist: ["api.tavily.com", "api.exa.ai"],
  }

  # Intentionally tight — the system prompt asks for "at most two searches"
  # but we cap at 1 here, so a follow-up search should trip the gate.
  budget per_tool: { web_search: { max_calls: 1 } },
         per_run:  { max_calls: 4 }

  def research(question)
    generate "research the question and return a short summary with sources" do
      with context: question
      returns WebResearchResult
    end
  end
end
