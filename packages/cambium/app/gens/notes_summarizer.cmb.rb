# #169: the forcing use-case in miniature — summarize a Markdown
# document and cite it. The point of the example is the `format:` the
# operator never has to write: `from:` ends in `.md`, so the compiler
# stamps `policies.grounding.format: "markdown"` into the IR, and the
# verifier gets a plain-text view of the document alongside the raw
# Markdown. A model that quotes the visible text of a bold span, a link,
# or a table row verifies; before, it was told it fabricated the quote.

class NotesSummarizer < GenModel
  # Local-first by convention.
  model :default
  system :notes_summarizer
  temperature 0.2
  max_tokens 1200

  budget per_run: { max_tokens: 2_000 }

  # Bake the document in at compile time (RED-383). `--arg other.md`
  # still overrides it at run time, and the format follows whichever
  # path supplied the value.
  grounded_in :notes, from: "../../examples/fixtures/release_notes.md", require_citations: true

  returns do
    field :summary, String, description: 'Two or three sentences covering the release as a whole.'
    field :highlights, [] do
      field :title, String, description: 'A short label for this change.'
      field :detail, String, description: 'What changed, in the reader\'s terms.'
      field :citations, [] do
        field :quote, String, description: 'Verbatim text from the notes supporting this highlight.'
      end
    end
  end

  def summarize(document)
    generate "summarize the release notes and cite each highlight" do
      with context: document
    end
  end
end
