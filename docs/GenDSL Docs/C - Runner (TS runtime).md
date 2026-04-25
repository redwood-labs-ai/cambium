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
- Plan + read memory before the steps loop; commit after `finalOk` (trivial default OR retro-agent dispatch); close backends on any exit path (`process.once('exit', …)`).
- Emit trace events (`SecurityCheck`, `ToolCall`, `AgenticTurn`, `tool.permission.denied`, `tool.budget.exceeded`, `memory.read`, `memory.write`, `memory.prune`, etc.).

## Step pipeline order

Roughly, the runner does this per IR:

1. Load contracts + AJV
2. Load tool registry (builtin dir first, then app dir — app wins)
3. Resolve + validate tool permissions (`SecurityCheck`)
4. **Memory: plan + read** — open each bucket, read per strategy, inject the `## Memory` block into `ir.system` (skipped when `ir.mode === 'retro'` to prevent nested memory on retro agents)
5. Load enrichments, run enrichment sub-agents
6. Execute IR steps (`Generate` → `Validate` → `Repair` loop → `Correct` → `GroundingCheck` → `ExtractSignals` → triggers)
7. **Memory: commit** — if `finalOk`, either append one trivial-default `{input, output}` entry per bucket, OR invoke the retro agent (when `write_memory_via` is set) and apply its `MemoryWrites` tagged `written_by: 'agent:<ClassName>'`
8. Close backends + write `ir.json`, `trace.json`, `output.json`

## Model providers

Agentic mode (`mode :agentic` + tool-use loop) supports:

- **oMLX** (OpenAI-compatible). Config: `CAMBIUM_OMLX_BASEURL` (default `http://localhost:8080`), optional `CAMBIUM_OMLX_API_KEY`. Model id form: `"omlx:<name>"`.
- **Ollama** (RED-208). Config: `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`), no API key. Model id form: `"ollama:<name>"` or a bare name (Ollama is the default when no `provider:` prefix is given).

Single-turn `generate` (no tool-use) also supports both providers via the same model-id convention.

Request/response shaping for Ollama lives in `packages/cambium-runner/src/providers/ollama.ts` — small testable helpers that normalize Ollama's `/api/chat` shape to the canonical `{ message: { content, tool_calls }, usage }` the dispatch site expects (synthesizes missing tool-call IDs, stringifies object-shaped `function.arguments`).

## The runner's own network calls

The runner's calls to the model backend (oMLX or Ollama) — both `generateText` and `embedText` — use `globalThis.fetch` directly. This is intentional — the gen's `security` block is about *tool* egress, not the runner's backend call. If the gen's security policy could block the model API itself, the gen couldn't run at all.

Tool calls remain fully guarded: every tool dispatch builds a `ToolContext` with a policy-bound `ctx.fetch`, and the SSRF guard (DNS-resolve-all, IP pinning) runs at fetch time. See [[S - Tool Sandboxing (RED-137)]].

## Optional subsystems

The memory subsystem (`packages/cambium-runner/src/memory/`, `packages/cambium-runner/src/providers/embed.ts`) is gated behind dynamic imports of `better-sqlite3` and `sqlite-vec`, both in `optionalDependencies`. A gen with no `memory :...` decls never triggers the import. A gen that uses memory without the deps installed gets a clear plan-time error pointing at `npm install better-sqlite3 sqlite-vec`.

## See also

- [[C - IR (Intermediate Representation)]]
- [[C - Trace (observability)]]
- [[S - Tool Sandboxing (RED-137)]]
- [[P - Memory]]
- [[N - Model Identifiers]]
