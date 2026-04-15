# Note: Model Identifiers (provider:model)

**Doc ID:** gen-dsl/note/model-identifiers

## Recommendation

Use the readable string form `"<provider>:<model>"`:

- `"omlx:Qwen3.5-27B-4bit"` — oMLX server (OpenAI-compatible). Most common in Cambium today.
- `"ollama:llama3:70b"` — local Ollama daemon (RED-208). Supports tool-use / agentic mode.

If no `provider:` prefix is given, the bare string is treated as `"ollama:<name>"` — Ollama is the default because it's the zero-config local option.

## Supported providers (current)

| Provider | Agentic mode | Config |
|---|---|---|
| `omlx`   | ✅ | `CAMBIUM_OMLX_BASEURL`, optional `CAMBIUM_OMLX_API_KEY` |
| `ollama` | ✅ | `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`) |

Agentic mode is the tool-use loop (`mode :agentic`). Single-turn `generate` works for both providers too.

## See also
- [[P - GenModel]]
- [[C - Runner (TS runtime)]]
