# Note: Model Identifiers (provider:model)

**Doc ID:** gen-dsl/note/model-identifiers

## Recommendation

Use the readable string form `"<provider>:<model>"`:

- `"omlx:Qwen3.5-27B-4bit"` — oMLX server (OpenAI-compatible). Most common in Cambium today.
- `"ollama:llama3:70b"` — local Ollama daemon (RED-208). Supports tool-use / agentic mode.

If no `provider:` prefix is given, the bare string is treated as `"ollama:<name>"` — Ollama is the default because it's the zero-config local option.

## Supported providers (current)

| Provider | Agentic mode | Embed | Config |
|---|---|---|---|
| `omlx`   | ✅ | ✅ (`POST /v1/embeddings`) | `CAMBIUM_OMLX_BASEURL`, optional `CAMBIUM_OMLX_API_KEY` |
| `ollama` | ✅ | ✅ (`POST /api/embed`) | `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`) |

Agentic mode is the tool-use loop (`mode :agentic`). Single-turn `generate` works for both providers too.

## Embed model identifiers (RED-215)

Memory pools and memory decls with `strategy: :semantic` take an `embed:` value that follows the same `"<provider>:<name>"` convention as primary models:

```ruby
memory :facts, strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"
```

Phase 5 requires the provider-prefix form. Bare alias names (`embed: :embedding`) are coordinated with **RED-237** (workspace-configurable `:default`/aliased model ids) — once that lands, pool files can reference aliases so a workspace-wide embed-model swap is a one-line change.

## See also
- [[P - GenModel]]
- [[P - Memory]]
- [[C - Runner (TS runtime)]]
