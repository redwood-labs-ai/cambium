# Note: Model Identifiers (provider:model)

**Doc ID:** gen-dsl/note/model-identifiers

## Recommendation

Use the readable string form `"<provider>:<model>"`:

- `"omlx:Qwen3.5-27B-4bit"` — oMLX server (OpenAI-compatible). Most common in Cambium today.
- `"ollama:llama3:70b"` — local Ollama daemon (RED-208). Supports tool-use / agentic mode.
- `"anthropic:claude-sonnet-4-6"` — Anthropic Messages API (RED-321). Supports tool-use / agentic mode; prompt caching is on by default.

If no `provider:` prefix is given, the bare string is treated as `"ollama:<name>"` — Ollama is the default because it's the zero-config local option.

## Supported providers (current)

| Provider    | Agentic mode | Embed | Prompt caching | Config |
|---|---|---|---|---|
| `omlx`      | ✅ | ✅ (`POST /v1/embeddings`) | n/a | `CAMBIUM_OMLX_BASEURL`, optional `CAMBIUM_OMLX_API_KEY` |
| `ollama`    | ✅ | ✅ (`POST /api/embed`) | n/a | `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`) |
| `anthropic` | ✅ | ❌ (no native embeddings API) | ✅ system + last tool + last doc + grounded user-prefix | `ANTHROPIC_API_KEY` (or `CAMBIUM_ANTHROPIC_API_KEY`), optional `CAMBIUM_ANTHROPIC_BASEURL` (default `https://api.anthropic.com`) |

Agentic mode is the tool-use loop (`mode :agentic`). Single-turn `generate` works for all three providers.

## How the prefix resolves to a provider (RED-393)

The runner dispatches every model call through a **provider registry** keyed by the model-id prefix. `model "anthropic:claude-sonnet-4-6"` → the registry's `anthropic` provider; a bare `"llama3"` (no prefix) → `ollama`. The registry is built per-run: framework built-ins (`anthropic`, `omlx`, `ollama`) first, then app-supplied `app/providers/*.ts`, then engine-mode `<prefix>.provider.ts` siblings (RED-424) — **last write wins, so a later layer shadows an earlier one with the same prefix** (the override hook, same stance as tools/correctors). Load order: builtin < app < engine sibling.

The dispatcher owns the cross-cutting concerns — prefix parse, Qwen thinking auto-detect, the native-document support gate (`provider.supportsDocuments`), the `--mock` short-circuit, fetch-failure hinting, and inline tool-call markup parsing. A provider implements ONLY build-body → fetch → normalize, so app providers inherit all the gates for free.

## Custom providers (RED-393)

Add a provider — Bedrock, Azure OpenAI, OpenRouter, Vertex, a self-hosted gateway — without forking the runner and **with zero new dependencies** (Cambium ships no provider SDKs; built-ins are raw `fetch`). One file, `app/providers/<name>.ts`, `export default` a provider; **the filename is the model-id prefix**.

Scaffold one with `cambium new provider <Name>` — it emits an `openaiCompatible` template (the Tier-1 shape below) with the `validateProviderBaseUrl` SSRF guard already wired and a `name` matching the filename. `cambium lint` then checks every `app/providers/*.ts` for the basename regex, an `export default`, and name/filename agreement.

**Engine mode (RED-424):** an embedded host places the file as `<prefix>.provider.ts` directly in the engine folder (no `app/providers/` subdirectory) — the discriminating suffix the runner's `loadFromEngineDir` scans for, since a flat engine folder's bare `.ts` files (`schemas.ts`, `index.ts`, `*.corrector.ts`) can't be assumed to be providers. Same filename-as-prefix rule, same guards, same factory imports. `cambium new provider <Name>` emits the sibling when run from inside an engine folder, and `cambium lint` checks engine `*.provider.ts` siblings with the same rules as `app/providers/*.ts`.

Two authoring tiers:

**Tier 1 — factories** (the common "different base URL + auth header" case). `openaiCompatible({...})` / `anthropicCompatible({...})` compose the framework's own request/normalize logic:

```ts
// app/providers/openrouter.ts  →  model "openrouter:anthropic/claude-3.5"
import { openaiCompatible, validateProviderBaseUrl } from '@redwood-labs/cambium-runner';

export default openaiCompatible({
  name: 'openrouter',
  supportsDocuments: false,
  baseUrl: () => {
    const url = process.env.OPENROUTER_BASEURL ?? 'https://openrouter.ai/api';
    validateProviderBaseUrl('openrouter', url);
    return url;
  },
  auth: () => process.env.OPENROUTER_API_KEY,   // resolved from env at call time
});
```

The `modelName` knob maps Cambium's clean name → the wire id the API wants (function OR an object map for Azure-deployment sugar). It applies only at request-build time — the IR, trace, and aliases keep the clean `provider:name` form; the wire id never leaks past the provider boundary.

**Tier 2 — `defineProvider({...})`** when the API isn't OpenAI/Anthropic-shaped (full control over build/fetch/normalize). This is how the built-in `ollama` provider is written. With full control comes full responsibility: **a Tier-2 provider must call `validateProviderBaseUrl(label, url)` itself before each `fetch`** — the SSRF guard that blocks private/metadata ranges is applied automatically by the Tier-1 factories, but `defineProvider` does no fetching on your behalf, so the check is yours to make.

The in-repo example is `packages/cambium/app/providers/gateway.ts` — a no-SDK OpenAI-compatible gateway.

### Conventions + guards

- **Filename = model-id prefix**, matched `/^[a-z][a-z0-9_]*$/`. If the provider sets a `name`, it must equal the filename (honesty check) or discovery throws.
- `export default` must implement both `generateText` and `generateWithTools`.
- Secrets resolve from env via the `auth` callback — never bake a key into the file.
- The base URL is operator-controlled (same trust boundary as `CAMBIUM_OMLX_BASEURL`); run it through `validateProviderBaseUrl` for the SSRF guard.
- Set `supportsDocuments` honestly — `false` makes the runtime fail fast on a native-document gen instead of stringifying a base64 blob into the prompt.
- Set `supportsPromptCacheControl` honestly — `true` tells the runner to forward `GenerateTextOpts.cachedPrefix` to the provider as a separate cached block; `false`/absent makes the runner flatten `cachedPrefix` into `prompt` before dispatch so the provider always sees a single string. The `anthropicCompatible` factory sets it from `config.cache !== false`.

### Bedrock (consumer recipe, not shipped)

Bedrock needs AWS SigV4, which means an AWS SDK. That's the **consumer's** dependency, not Cambium's — write `app/providers/bedrock.ts` with `defineProvider`, import `@aws-sdk/...` in your own app, and sign the request inside `generateText`/`generateWithTools`. Run the endpoint through `validateProviderBaseUrl` before signing (Tier-2 providers don't get the factory's automatic SSRF guard). Cambium stays SDK-free; your app owns its own dependency hygiene.

## Multi-provider fallback (RED-421)

`model` accepts multiple model ids as ordered varargs:

```ruby
model "anthropic:claude-opus", "bedrock:claude-opus"   # primary, then fallback
model "omlx:big", "omlx:medium", "ollama:small"        # ordered chain
```

On a **transient** failure of the primary, the runner tries the next candidate in declaration order through the same per-run `ProviderRegistry`. The **transient** set (RED-421, DEC-A/DEC-C/DEC-D):

- `ProviderHttpError` with status 5xx, 408, 425, or 429 — the server responded but the response signals a retriable condition.
- `ProviderConnectionError` with status 0 — no HTTP response at all (ECONNREFUSED, DNS failure, TLS error). Built-in providers (`omlx`, `anthropic`, `ollama`) emit this automatically when the underlying `fetch()` rejects. DEC-D.

**Deterministic** failures (any other 4xx) fail immediately — the same bad request fails on every provider, so fanning out only burns spend.

- Each id resolves through model aliases at compile time (RED-237); no runtime alias resolution. The IR carries literal `provider:name` strings in `model.id` (primary) and `model.fallbacks[]` (rest) — see `C - IR` § `model.fallbacks`.
- No stickiness in v1: each generation attempt (including a repair re-generation) walks the list fresh from the primary.
- A `ModelFallback` trace step is emitted before each fallback attempt, recording the model that failed, the error class, and the candidate tried next. See `C - Trace (observability).md`.
- The native-document gate runs against the **primary** provider before any fallback (and per-candidate for fallbacks): a document-bearing gen on a non-document provider fails fast rather than silently dropping the document to enable fallback.
- **Custom providers** that want retry-on-transient for HTTP-status failures must throw `ProviderHttpError` (exported from `@redwood-labs/cambium-runner`), carrying the HTTP status. For pre-response connection failures (no HTTP response — ECONNREFUSED, DNS, TLS), throw `ProviderConnectionError` instead (also exported from `@redwood-labs/cambium-runner`; subclasses `ProviderHttpError` with `status: 0`). A plain `Error` or `TypeError` — any non-`ProviderHttpError` — is classified **deterministic**, so an unrecognized failure produces controlled fail-fast rather than a cost-blowing fan-out to every fallback. DEC-A is unchanged: the type-gate, not a `.status` property, determines classification.

## Anthropic prompt caching (RED-321)

`buildAnthropicMessagesRequest` automatically applies `cache_control: {type: 'ephemeral'}` to up to four blocks — Anthropic's per-request breakpoint ceiling:

1. The top-level `system` block (always, when a system prompt exists).
2. The last entry in `tools[]` (which caches the whole tools array up through it).
3. The last native-document block (RED-323), when document input is present — caches the whole document stack up through it.
4. The shared user-prompt prefix — DOCUMENT + non-primary context sections + OUTPUT_JSON_TEMPLATE — for gens that declare `grounded_in`, when the shared payload is ≥ `MIN_CACHE_PREFIX_CHARS` (~4 KB). This fires automatically for grounded fan-out gens: the prefix is byte-identical across candidates, so branch 1 writes the cache (`cache_creation_input_tokens`) and branches 2..N read it (`cache_read_input_tokens`). The split happens only on the single-turn `generateText` path; the agentic loop is unchanged. Blocks 2 and 4 never co-occur on one request (separate code paths), so four is a ceiling, not a typical count.

Cache stats surface through the usual usage channel and are carried in the trace:

```json
"usage": {
  "prompt_tokens": 1200,
  "completion_tokens": 340,
  "total_tokens": 1540,
  "cache_creation_input_tokens": 1100,
  "cache_read_input_tokens": 0
}
```

On the second agentic turn (or second run in the same process), stable system + tool content hits the cache: `cache_read_input_tokens` becomes large and `input_tokens` drops to just the new user message + conversation additions. The total reported `prompt_tokens` follows Anthropic's own accounting — cache reads are billed at ~10% of normal input pricing.

Caching is on by default because the cost/latency improvement is monotonic when prompts + tools are stable within a run. It can be turned off via `buildAnthropicMessagesRequest({ ..., cache: false })` at the library level, but there's no DSL surface for this — framework-owned behavior, same stance as oMLX's `/no_think` injection.

### Non-goal: forced-schema

Anthropic has no native schema-enforced decoding like oMLX's xgrammar. Cambium relies on Claude's first-pass JSON quality plus the existing repair loop. If future evidence shows the repair loop is firing often, an opt-in `CAMBIUM_ANTHROPIC_SCHEMA_MODE=tool_use` forced-tool-call path is a safe follow-up — it's deliberately NOT wired today to keep the `generateText` surface free of synthetic tools that would collide with real agentic tools.

### Non-goal: embeddings

Anthropic doesn't offer an embeddings endpoint. `src/providers/embed.ts` stays oMLX + Ollama. Anthropic-primary gens that need semantic memory should pair with an oMLX or Ollama embed model (embed provider is independent of chat provider).

## Native document input (RED-323)

Anthropic's Messages API accepts typed content blocks for PDFs and images. Cambium's runner surfaces this via `ir.context`: string values continue to flow into the prompt as text, but **object values matching the document envelope shape** are extracted and emitted as content blocks instead.

### Envelope shape

```ruby
# In a gen's method body — `with context:` accepts this hash directly:
generate "analyze the invoice" do
  with context: {
    invoice: {
      kind: "base64_pdf",
      data: base64_encoded_pdf,
      media_type: "application/pdf",
    },
  }
  returns InvoiceExtraction
end
```

Or from engine-mode / a direct `runGen` call:

```ts
await runGen({
  ir: {
    // ...
    context: {
      invoice: { kind: 'base64_pdf', data: b64, media_type: 'application/pdf' },
      note: 'Customer is a repeat buyer.',  // plain text still works
    },
  },
  schemas: { InvoiceExtraction },
});
```

Supported `kind` values:
- `"base64_pdf"` — `media_type` must be `"application/pdf"`
- `"base64_image"` — `media_type` one of `"image/png"`, `"image/jpeg"`, `"image/gif"`, `"image/webp"`

### Wire shape (Anthropic)

The provider emits the document block BEFORE the text block in the first user message:

```json
{
  "role": "user",
  "content": [
    { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "..." }, "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "<the compiled prompt>" }
  ]
}
```

The `cache_control: ephemeral` on the last document block caches the doc bytes across agentic turns and subsequent runs in the same process.

### Size limits

- Per-document: 32 MiB (Anthropic's stated PDF limit)
- Per-run total: 50 MiB across all documents. Override via `CAMBIUM_MAX_DOC_BYTES_PER_RUN=<bytes>`.

Malformed base64, missing `media_type`, wrong `media_type` for the declared `kind`, and size overruns all raise fail-fast errors at extraction time — before any provider call.

### Grounding interaction

`grounded_in :<key>` works natively with `base64_pdf` envelopes as of 0.3.1 (RED-323 follow-up). The runner extracts the PDF's plain text via `pdfjs-dist` and feeds that text into Cambium's citation verifier — so the model reasons over the PDF as a native document block (preserving Claude's native PDF capabilities), AND Cambium verifies every cited quote against the extracted text.

```ruby
class InvoiceAnalyst < GenModel
  model :default
  returns InvoiceReport
  grounded_in :invoice, require_citations: true

  def analyze(pdf_base64)
    generate "extract key facts and cite them" do
      with context: {
        invoice: {
          kind: "base64_pdf",
          data: pdf_base64,
          media_type: "application/pdf",
        },
      }
      returns InvoiceReport
    end
  end
end
```

Every `citations[].quote` field in the output is checked verbatim against the PDF's extracted text. Quotes that don't match feed into the repair loop; unhealed errors surface as `GroundingCheck.ok: false`.

**Scanned/image-only PDFs:** if a PDF has no selectable text (scanned images only), extraction produces an empty result and the run fails with a clear error. OCR is out of scope for v1.

**Images with `grounded_in`:** not supported — images require OCR, deferred. A gen that pairs `grounded_in :<key>` with `{ kind: 'base64_image' }` will not get citation verification, since there's no text to verify against.

**Pre-0.3.1 behavior:** earlier 0.3.0 rejected `grounded_in` + `base64_pdf` with a hard compile-time error. That was wrong. The 0.3.1 patch release removed the guard and wired in real text extraction.

### Non-Anthropic providers

Ollama and oMLX have no native document support today. A gen that passes a typed doc object with an `ollama:` or `omlx:` model fails fast at dispatch with a clear message — don't silently JSON-stringify the base64 into the prompt (it would be a token bomb). Pre-extract to text when using those providers.

## Model options: `disable_thinking` (RED-325, 0.3.2)

Qwen 3.x and other thinking-enabled models emit huge `reasoning_content` blocks before the actual JSON output, which (a) blows token budgets and (b) confuses Cambium's parser when the final answer leaks into `reasoning_content` instead of `content`. The `disable_thinking` model option suppresses thinking-mode at the source.

```ruby
class FastReviewer < GenModel
  model "omlx:Qwen3.5-27B-4bit", disable_thinking: true
end
```

Effect on the request: sets `chat_template_kwargs.enable_thinking: false` in the OpenAI-compat request body AND injects `/no_think` into both system and user prompts (some Qwen builds only respect it in system position). Three signals stacked.

**Auto-detection:** if the model id matches `/qwen3/i` and `disable_thinking` is not explicitly set, Cambium defaults it to `true` and emits a one-time stderr note. To opt back into thinking, set `disable_thinking: false` explicitly.

**Provider-error fallback (RED-325 Part 4):** if a thinking model still leaks the answer to `reasoning_content` despite the suppression, the runner falls back to reading from `reasoning_content` with a stderr warning rather than failing. Less correct than fixing the source — but it stops a silent failure when an unknown thinking-model variant slips past auto-detection.

This is an oMLX-specific surface today. Anthropic and Ollama don't have an equivalent thinking-mode toggle — `disable_thinking: true` is silently ignored for `anthropic:` and `ollama:` model ids. (Anthropic's extended-thinking mode is a separate API surface controlled by request-shape decisions in `providers/anthropic.ts`, not by a DSL-level kwarg.)

## Provider base-URL validation (RED-322 / RED-325 Part 5, 0.3.2)

Operator-controlled `CAMBIUM_*_BASEURL` env vars are validated at first dispatch:

- Reject non-`https://` UNLESS host is localhost (`127.0.0.1`, `::1`)
- Reject private-range IPs (RFC1918 + 169.254 + ULA + link-local IPv6)
- Tailscale CGNAT (100.64.0.0/10) is intentionally allowed (so tailnet/wg-fronted self-hosted models work over https without the escape hatch)

Escape hatch: `CAMBIUM_ALLOW_PRIVATE_PROVIDER_BASEURL=1` opts in to BOTH private-range URLs AND non-https schemes on non-localhost hosts (legitimate internal-VLAN proxy setups, Tailscale-CGNAT-over-http, etc). When engaged, Cambium emits a one-time stderr warning per (provider, URL, gate) so the choice is auditable. A URL that trips both gates (e.g. `http://192.168.1.100`) produces two distinct warnings — one for scheme, one for range.

The check is once-per-(provider, URL) — startup cost is negligible. Hostnames pass without DNS resolution; the validator targets static URL strings (the misconfigured-env vector), not DNS-rebinding.

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
- The IR never carries symbols — the runner only sees resolved literal strings. This keeps the runtime layer blissfully unaware of the alias mechanism. Don't add runtime alias resolution — it would split the source of truth across two layers and break the "IR is truth" stance. If you need runtime model selection (env override, A/B), do it at IR-post-processing or add a separate mechanism; don't reuse aliases.

**Why aliases:** before RED-237 every gen hard-coded its model string, and switching models across a fleet of gens was find-and-replace. Memory pools compounded the pain by repeating the embed model. Aliases collapse that to a single edit per workspace.

**Coordinates with RED-238:** semantic query source overrides — orthogonal to alias resolution but touches the same memory decl surface.

## Profile-driven model selection (RED-326)

Static aliases swap a name for one literal. **Profiles** swap the same name for *different* literals depending on environment — dev runs on local Qwen, prod runs on hosted Anthropic, no Ruby conditionals required.

```ruby
# app/config/models.rb

# Globals — available in every profile, useful for aliases that don't
# change between dev and prod (e.g. a code-review model where you want
# the same quality everywhere).
codereview "anthropic:claude-opus-4-7"

profile :dev do
  default   "omlx:Qwen3.5-27B-4bit"
  fast      "omlx:gemma-4-31b-it-8bit"
  embedding "omlx:bge-small-en"
end

profile :prod do
  default   "anthropic:claude-sonnet-4-6"
  fast      "anthropic:claude-haiku-4-5-20251001"
  embedding "omlx:bge-small-en"  # embeddings can pin a provider regardless of chat profile
end
```

**Active profile selection** at compile time:

| Priority | Source | Behavior |
| -- | -- | -- |
| 1 | `--profile <name>` CLI flag | Wins over env. CLI sets `CAMBIUM_PROFILE` for the Ruby subprocess. |
| 2 | `CAMBIUM_PROFILE` env var | Used when no `--profile` was passed. Useful for deployment manifests. |
| 3 | A profile literally named `:dev` | Implicit default if declared. |
| 4 | First declared profile | Used when there's no `:dev` and the operator hasn't picked one. |

Profile-scoped aliases shadow globals of the same name. Both `:dev` and `:prod` can declare `default`; the active profile's value wins, and `codereview` (global) is the same in either profile.

**Back-compat (RED-237):** a workspace with NO `profile` blocks behaves exactly as it did pre-RED-326 — only the top-level aliases are visible, no profile resolution happens, the IR is identical.

**Error behavior:**

- `CAMBIUM_PROFILE=staging` when `models.rb` only declares `:dev` and `:prod` → `CompileError` naming the available profiles.
- A gen references `:default` but the active profile doesn't define it (and there's no global `default`) → existing "unknown model alias" error, now annotated with the active profile name and the list of declared profiles so the operator can see which scope they're in.

**Non-goals (today, may file follow-ups):**

- Per-gen profile override (`model :default, profile: :prod` to let one gen run prod-quality while sibling gens stay on dev).
- Profile-driven non-model config (memory pools, policy packs). Possibly the natural extension if profiles prove useful in practice.

## See also
- [[P - GenModel]]
- [[P - Memory]]
- [[C - Runner (TS runtime)]]
