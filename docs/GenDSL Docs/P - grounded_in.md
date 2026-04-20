# Primitive: grounded_in

**Doc ID:** gen-dsl/primitive/grounded-in

## Purpose
Enforce that outputs are grounded in a source document with verifiable citations. When grounding is active, the model must include verbatim quotes from the source, and the runtime verifies them.

## Semantics (normative)
- When `require_citations: true`, the runner MUST verify all citation quotes against the source document.
- Citation verification is fuzzy (case-insensitive, whitespace-normalized) but requires substring match.
- Fabricated citations (quotes not found in the source) are flagged as errors and fed into the repair loop.
- Missing citations (items without any citations) are flagged as errors.
- The runtime auto-registers the `citations` corrector — the author does not need to also declare `corrects :citations`.
- Grounding rules are injected into the system prompt, instructing the model to use exact verbatim quotes.

## Example
```ruby
class Analyst < GenModel
  returns AnalysisReport
  grounded_in :document, require_citations: true

  def analyze(document)
    generate "analyze this document" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

The symbol passed to `grounded_in` is the canonical name of the source. The compiler uses it as the key under `ir.context` — so a gen with `grounded_in :linear_issue` emits `"context": { "linear_issue": "..." }` rather than the default `"document"` key (RED-276). All runtime code paths (prompt assembly, citation verification, review, memory read) resolve the source via `ir.policies.grounding.source`, falling back to `context.document` when no grounding is declared. A gen without `grounded_in` keeps the default `document` shape for back-compat.

## What happens at runtime
1. System prompt includes GROUNDING RULES telling the model to produce verbatim quotes
2. Model generates output with citations
3. Regular correctors run (math, dates, etc.)
4. **GroundingCheck**: citations corrector verifies every quote exists in the source document
5. If fabricated quotes found → repair loop with specific error messages
6. If all quotes verified → grounding passes

## IR output
```json
"policies": {
  "grounding": {
    "source": "linear_issue",
    "require_citations": true
  }
},
"context": {
  "linear_issue": "..."
}
```

Note the `context` key matches the grounding `source` — the two stay aligned by the compiler. Gens without `grounded_in` emit `"context": { "document": "..." }`.

## Failure modes
- Fabricated quote: model invents text not in the document → error, triggers repair
- Missing citations: item has no citations → error, triggers repair
- Source not available: context field not found → grounding skipped

## See also
- [[D - Grounding Sources]]
- [[C - Repair Loop]]
- [[C - Schema Description (auto-generated)]]
- [[P - returns]]
