# Scanner Pattern Generator
#
# Takes a Linear issue (vulnerability description) and produces a
# detection pattern for redwood-scanner.
#
# Mode: agentic — needs to research, read files, and refine patterns
# Tools: tavily (research), codebase_reader (source), linear (issue mgmt)
# Corrector: regex_validation (deterministic regex + test case validation)

class ScannerPattern < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :scanner
  temperature 0.2
  max_tokens 2000
  mode :agentic

  returns PatternResult

  # Tools: deny-by-default, only these three
  uses :tavily, :codebase_reader, :linear

  # Corrector: validate regex syntax + test cases deterministically
  corrects :regex_validation

  # Budget: cap tool usage to prevent runaway research loops
  constrain :budget, max_tool_calls: 15

  # Security: allow network (tavily, linear) and filesystem (codebase_reader)
  security allow_network: true, allow_filesystem: true

  # Consistency: one extra pass to check pattern stability
  constrain :consistency, passes: 1

  # Extract confidence as a signal for downstream decisions
  extract :confidence, type: :number, path: "confidence"

  # Trigger: if confidence is low, flag for human review
  # NOTE: trigger DSL only supports tool_call action.
  # TODO: need webhook or linear_update action type for "flag low confidence"
  # on :confidence do
  #   tool :linear, action: "comment", body: "Low confidence pattern — needs human review"
  # end

  def generate_pattern(issue)
    generate "generate scanner detection pattern for vulnerability" do
      with context: issue
      returns PatternResult
    end
  end
end
