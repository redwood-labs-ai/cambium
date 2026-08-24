# Golden fixture for the `effort` primitive (RED-325).
#
# Effort is an Anthropic-only steering control for models that dropped
# sampling params (Opus 4.7+, Fable 5, Mythos 5), so this fixture is the
# one in-tree gen pinned to an `anthropic:` model id.
#
# It exists because `effort` originally shipped with no compile-side
# coverage at all: every other gen leaves it unset, so the validation
# branch in compile.rb was never executed by a test and a typo in it went
# unnoticed. This gen keeps the emitted-when-set shape pinned; the two
# rejection cases in tests/golden/rejection-cases.ts cover the error paths.

class EffortAnthropic < GenModel
  model "anthropic:claude-opus-4-7"
  system "inline system prompt"

  effort :high

  returns do
    field :result, String
  end

  def analyze(document)
    generate "analyze the document" do
      with context: document
    end
  end
end
