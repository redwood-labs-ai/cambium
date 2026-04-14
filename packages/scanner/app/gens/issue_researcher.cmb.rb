# Issue Researcher — enrichment sub-agent
#
# Pre-processes a Linear issue by researching the vulnerability class.
# Returns enriched context with CVE references, detection approaches,
# and related patterns.
#
# This runs BEFORE the main ScannerPattern generation.

class IssueResearcher < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :scanner
  temperature 0.3
  max_tokens 1500
  mode :agentic

  returns IssueResearch
  uses :tavily
  constrain :budget, max_tool_calls: 5

  def research(issue)
    generate "research vulnerability class and detection approaches" do
      with context: issue
      returns IssueResearch
    end
  end
end
