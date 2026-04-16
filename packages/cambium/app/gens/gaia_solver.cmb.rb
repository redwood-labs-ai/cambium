# GAIA benchmark solver agent.
# Uses agentic mode to call tools mid-generation for research + computation.

class GaiaSolver < GenModel
  model :fast
  system :gaia_solver
  mode :agentic
  temperature 0.1
  max_tokens 1200

  returns GaiaAnswer

  uses :web_search, :web_extract, :calculator, :execute_code
  security \
    network: { allowlist: ["*"] },
    exec: { allowed: true }

  constrain :budget, max_tool_calls: 4, max_duration: "8m"

  def solve(question)
    generate "answer this question precisely using available tools" do
      with context: question
      returns GaiaAnswer
    end
  end
end
