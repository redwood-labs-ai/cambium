# Agentic tool scaffolder (RED-216).
#
# Takes a one-sentence description of a new tool and returns a typed
# plan (name, permissions, schemas, handler source). A thin CLI wrapper
# (`cambium new tool --describe "..."`) runs this gen and writes the
# proposed files on user confirm.
#
# Self-dogfooding: Cambium uses Cambium to build its own tool scaffolds.

class ToolScaffold < GenModel
  model :default
  system :tool_scaffold
  temperature 0.2
  max_tokens 1500

  returns ToolScaffoldResult

  # Single-shot for v1 — no tools needed. The system prompt carries the
  # conventions; the model generates the plan in one turn. If users ask
  # for "look at my existing tools for conventions," upgrade to agentic
  # with codebase_reader in a follow-up.

  def scaffold(description)
    generate "generate a tool scaffold plan for this description" do
      with context: description
      returns ToolScaffoldResult
    end
  end
end
