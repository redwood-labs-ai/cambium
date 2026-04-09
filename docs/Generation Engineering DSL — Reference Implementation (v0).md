# Generation Engineering DSL — Reference Implementation (v0)

This note is a concrete, end-to-end example that matches the spec draft:
- Ruby DSL authoring
- Rails-style app structure
- Compile to IR (JSON plan)
- Execute via a TS/Node runner
- Validate + repair loop
- Trace output with provenance

---

## Conventions: model identifiers (LLM-first, local-first)

We should be **local-first** by convention, with an explicit provider prefix when needed.

Recommended format (human + LLM readable):

- **Default provider** (configured in `config/gen.yml`):
  - `model "llama3:70b"`

- **Explicit provider** (when not default):
  - `model "ollama:llama3:70b"`
  - `model "mlx:Qwen3.5-27B-4bit"`
  - `model "openai:gpt-5"`

This is deliberately “URL-ish” without introducing Rust `::` semantics.

Resolution rules:
1) If string contains `provider:` prefix, use that adapter.
2) Otherwise, use `default_provider` from config.

---

## Minimal app layout

```
my-gen-app/
  app/
    gens/
      analyst.rgen
    schemas/
      analysis_report.schema.json
    tools/
      calculator.tool.json
    grounding/
      company_docs.grounding.yml
    correctors/
      math.corrector.yml
      dates.corrector.yml
      currency.corrector.yml
  config/
    gen.yml
```

---

## config/gen.yml (defaults)

```yml
# config/gen.yml
runtime:
  trace: true
  trace_format: json

models:
  default_provider: ollama
  max_repair_attempts: 2

grounding:
  require_citations_by_default: true

security:
  tools:
    deny_by_default: true
```

---

## Schema: AnalysisReport

```json
{
  "$id": "AnalysisReport",
  "type": "object",
  "required": ["summary", "key_claims"],
  "properties": {
    "summary": {"type": "string"},
    "key_claims": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["claim", "citations"],
        "properties": {
          "claim": {"type": "string"},
          "citations": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["doc_id", "chunk_id"],
              "properties": {
                "doc_id": {"type": "string"},
                "chunk_id": {"type": "string"},
                "quote": {"type": "string"}
              }
            }
          }
        }
      }
    },
    "computed": {
      "type": "object",
      "properties": {
        "revenue_usd": {"type": ["number", "null"]},
        "as_of_date": {"type": ["string", "null"]}
      }
    }
  }
}
```

---

## Tool: calculator

```json
{
  "name": "calculator",
  "description": "Deterministic math evaluation",
  "inputSchema": {
    "type": "object",
    "required": ["expression"],
    "properties": {
      "expression": {"type": "string"}
    }
  },
  "outputSchema": {
    "type": "object",
    "required": ["value"],
    "properties": {
      "value": {"type": "number"}
    }
  }
}
```

---

## app/gens/analyst.rgen (Ruby DSL)

```ruby
class Analyst < GenModel
  model "ollama:llama3:70b"
  temperature 0.2
  max_tokens 2000

  grounded_in :company_docs
  uses :vector_search, :calculator
  corrects :math, :dates, :currency

  constrain :tone, to: :professional
  returns AnalysisReport

  def analyze(document)
    generate "analyze this document" do
      with context: document
      require_citations!
      returns AnalysisReport
    end
  end
end
```

---

## Compiled IR (JSON plan)

This is what the Ruby DSL compiles to. (Not final; illustrative v0.)

```json
{
  "version": "0.1",
  "model": {"provider": "ollama", "name": "llama3:70b", "temperature": 0.2, "max_tokens": 2000},
  "policies": {
    "grounding": {"enabled": true, "source": "company_docs", "require_citations": true},
    "tools": {"allowed": ["vector_search", "calculator"]},
    "repair": {"max_attempts": 2}
  },
  "returnSchema": "AnalysisReport",
  "steps": [
    {
      "id": "retrieve_company_docs",
      "type": "Retrieve",
      "source": "company_docs",
      "query": {"kind": "from_context", "path": "document"},
      "k": 8
    },
    {
      "id": "generate_analysis",
      "type": "Generate",
      "input": {
        "system": "You are a professional analyst. Output JSON that validates against schema: AnalysisReport.",
        "user": "Analyze the provided document. Extract key claims with citations.",
        "context": [
          {"ref": "document"},
          {"ref": "retrieve_company_docs.results"}
        ]
      },
      "expects": {"schema": "AnalysisReport"}
    },
    {
      "id": "validate",
      "type": "Validate",
      "schema": "AnalysisReport",
      "policies": ["require_citations"]
    },
    {
      "id": "repair_if_needed",
      "type": "Repair",
      "when": {"on": "validation_error"},
      "strategy": "edit_invalid_fields_only",
      "maxAttempts": 2
    },
    {
      "id": "return",
      "type": "Return",
      "value": {"ref": "generate_analysis.output"}
    }
  ]
}
```

---

## Example Trace Output (abbreviated)

```json
{
  "run_id": "run_2026_04_08_1145_abc123",
  "model": "ollama:llama3:70b",
  "timing_ms": {"total": 8420, "generate": 6200, "validate": 40, "repair": 2100},
  "steps": [
    {
      "id": "retrieve_company_docs",
      "type": "Retrieve",
      "results": [{"doc_id": "handbook", "chunk_id": "handbook_042"}]
    },
    {
      "id": "generate_analysis",
      "type": "Generate",
      "output_hash": "sha256:…",
      "tokens": {"in": 5400, "out": 880}
    },
    {
      "id": "validate",
      "type": "Validate",
      "ok": false,
      "errors": [
        {"path": ".key_claims[0].citations", "code": "missing_quote"}
      ]
    },
    {
      "id": "repair_if_needed",
      "type": "Repair",
      "attempt": 1,
      "instruction": "Fix ONLY invalid fields. Add quote strings to citations.",
      "ok": true
    }
  ],
  "final": {
    "schema": "AnalysisReport",
    "ok": true
  }
}
```

---

## Notes: why this matters

- The author writes a readable DSL.
- The system executes an explicit plan (IR), not an opaque prompt.
- Outputs are consumable by downstream systems because they are typed.
- Tool calls are permissioned + logged.
- Grounding is enforced as a policy, not a suggestion.

---

## Next improvements

- Add `ToolCall` steps into the IR (calculator runs as part of `:math` corrector)
- Add `Explain` command that summarizes a trace into human-readable debugging output
- Add doc-linkable IDs for every primitive (knowledge-graph docs)
- Add generators (`gen new model`, `gen new tool`, `gen new schema`)
