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

Embed slots also accept Symbol aliases via RED-237 (see below).

## Model aliases (RED-237)

Define workspace-wide aliases in `packages/cambium/app/config/models.rb`:

```ruby
default   "omlx:Qwen3.5-27B-4bit"
fast      "omlx:gemma-4-31b-it-8bit"
embedding "omlx:bge-small-en"
```

Then reference them by symbol in any gen or memory slot:

```ruby
class Analyst < GenModel
  model :default                                              # resolves at compile time
end

memory :facts, strategy: :semantic, top_k: 5, embed: :embedding  # also resolves at compile time
```

**Resolution rules (compile-time, in `ruby/cambium/compile.rb` via `Cambium::ModelAliases`):**

- Literal strings containing `:` pass through unchanged (`"omlx:anything"` always works).
- Symbols and bare-name strings are treated as alias references; they must be defined in `app/config/models.rb`.
- An undefined alias raises `CompileError` listing the available names and pointing at the config file.
- Aliases names MUST match `/\A[a-z][a-z0-9_]*\z/` (same safety regex as policy-pack and memory-pool names).
- The IR never carries symbols — the runner only sees resolved literal strings. This keeps the runtime layer blissfully unaware of the alias mechanism.

**Why aliases:** before RED-237 every gen hard-coded its model string, and switching models across a fleet of gens was find-and-replace. Memory pools compounded the pain by repeating the embed model. Aliases collapse that to a single edit per workspace.

**Coordinates with RED-238:** semantic query source overrides — orthogonal to alias resolution but touches the same memory decl surface.

## See also
- [[P - GenModel]]
- [[P - Memory]]
- [[C - Runner (TS runtime)]]
