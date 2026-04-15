# Runtime: Runner (TS runtime)

**Doc ID:** gen-dsl/runtime/runner

## Purpose
Execute IR steps with policy enforcement, validation, and full tracing. Single canonical interpreter — the value of the IR is that there is exactly one correct executor.

## Responsibilities

- Load app config + registries (schemas, tools, grounding sources, policy packs).
- Execute the IR step graph.
- Enforce:
  - tool allowlist (`ToolRegistry.assertAllowed`)
  - `security` policy (network allowlist + SSRF guard; filesystem roots; exec gate)
  - `budget` caps (per-tool + per-run, gated before dispatch)
  - grounding / citation verification
  - schema validation with repair loop
- Build the `ToolContext` (policy-bound `ctx.fetch`) per tool call.
- Emit trace events (`SecurityCheck`, `ToolCall`, `AgenticTurn`, `tool.permission.denied`, `tool.budget.exceeded`, etc.).

## Model providers

Agentic mode (`mode :agentic` + tool-use loop) supports:

- **oMLX** (OpenAI-compatible). Config: `CAMBIUM_OMLX_BASEURL` (default `http://100.114.183.54:8080`), optional `CAMBIUM_OMLX_API_KEY`. Model id form: `"omlx:<name>"`.
- **Ollama** (RED-208). Config: `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`), no API key. Model id form: `"ollama:<name>"` or a bare name (Ollama is the default when no `provider:` prefix is given).

Single-turn `generate` (no tool-use) also supports both providers via the same model-id convention.

Request/response shaping for Ollama lives in `src/providers/ollama.ts` — small testable helpers that normalize Ollama's `/api/chat` shape to the canonical `{ message: { content, tool_calls }, usage }` the dispatch site expects (synthesizes missing tool-call IDs, stringifies object-shaped `function.arguments`).

## The runner's own network calls

The runner's calls to the model backend (oMLX or Ollama) use `globalThis.fetch` directly. This is intentional — the gen's `security` block is about *tool* egress, not the runner's backend call. If the gen's security policy could block the model API itself, the gen couldn't run at all.

Tool calls remain fully guarded: every tool dispatch builds a `ToolContext` with a policy-bound `ctx.fetch`, and the SSRF guard (DNS-resolve-all, IP pinning) runs at fetch time. See [[S - Tool Sandboxing (RED-137)]].

## See also

- [[C - IR (Intermediate Representation)]]
- [[C - Trace (observability)]]
- [[S - Tool Sandboxing (RED-137)]]
- [[N - Model Identifiers]]
