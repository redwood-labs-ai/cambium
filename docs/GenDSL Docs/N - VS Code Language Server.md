# Note: VS Code Language Server (LSP)

**Doc ID:** gen-dsl/note/vscode-lsp

## Purpose
Provide hover docs, go-to-definition, and completions for `.cmb.rb` files. The TextMate grammar handles syntax coloring; the LSP handles intelligence.

## Features

### Hover
Show inline documentation when hovering over DSL primitives and references.

| Hover target | Shows |
|---|---|
| `system` | "Declares the system prompt. Symbol resolves to `app/systems/<name>.system.md`, string is inline." |
| `:analyst` | The contents of `app/systems/analyst.system.md` |
| `model` | "Declares the LLM provider and model. Format: `provider:model_name`." |
| `returns` | "Declares the return schema. Must match a TypeBox `$id` in `packages/cambium/src/contracts.ts`." |
| `AnalysisReport` | The TypeBox schema definition from `contracts.ts` |
| `uses` | "Declares allowed tools. Deny-by-default: undeclared tools cannot be called." |
| `:calculator` | The `description` field from `app/tools/calculator.tool.json` |
| `corrects` | "Attaches deterministic correctors. Run after validation, before triggers." |
| `constrain` | "Declares a runtime constraint. See: `:tone`, `:compound`, `:consistency`." |
| `:compound` | "Compound generation: LLM reviews output against source. `strategy: :review`." |
| `:consistency` | "Multi-pass consensus: generate N times, compare, flag disagreements." |
| `extract` | "Declares a typed signal extraction from the validated output." |
| `on` | "Declares a deterministic trigger. Fires when the named signal has values." |
| `generate` | "Executes a governed generation transaction with validate/repair/trace." |

### Go-to-definition (Cmd+click)
Navigate from references to their definitions.

| Click target | Jumps to |
|---|---|
| `:analyst` (after `system`) | `app/systems/analyst.system.md` |
| `:code_reviewer` (after `system`) | `app/systems/code_reviewer.system.md` |
| `:calculator` (after `uses` or `tool`) | `app/tools/calculator.tool.json` |
| `AnalysisReport` (after `returns`) | The export in `packages/cambium/src/contracts.ts` |
| `:math` (after `corrects`) | `packages/cambium-runner/src/correctors/math.ts` |
| `:latency_ms` (after `on`) | The `extract :latency_ms` declaration in the same file |

### Completions
Context-aware suggestions after DSL keywords.

| After typing | Suggests |
|---|---|
| `system :` | Names of `*.system.md` files in `app/systems/` |
| `uses :` | Names of `*.tool.json` files in `app/tools/` |
| `corrects :` | Built-in corrector names: `math`, `dates`, `currency` |
| `returns ` | TypeBox export names from `packages/cambium/src/contracts.ts` (by `$id`) |
| `constrain :` | Known constraint names: `tone`, `compound`, `consistency` |
| `on :` | Signal names declared via `extract` in the current file |

### Diagnostics (stretch)
Inline errors/warnings in the editor.

- `system :unknown_name` → error if `app/systems/unknown_name.system.md` doesn't exist
- `uses :missing_tool` → error if `app/tools/missing_tool.tool.json` doesn't exist
- `returns UnknownSchema` → warning if no matching `$id` in contracts
- `on :undefined_signal` → warning if no `extract` for that name in the file

## Architecture

```
vscode/cambium-syntax/
  package.json          # already exists (add LSP activation)
  syntaxes/             # already exists (TextMate grammar)
  src/
    extension.ts        # VS Code client: activates server, registers commands
    server.ts           # Language server: hover, definitions, completions
```

### Server implementation approach
- Parse `.cmb.rb` files with regex/line-based matching (not a full Ruby parser — the DSL surface is small and regular)
- Scan `app/systems/`, `app/tools/`, `packages/cambium/src/contracts.ts`, `packages/cambium-runner/src/correctors/` on startup to build a symbol index
- Watch those directories for changes via VS Code file watcher
- Use `vscode-languageserver` + `vscode-languageclient` packages

### Dependencies
- `vscode-languageserver` (server-side)
- `vscode-languageclient` (client-side)
- `typescript` (build)

## Scope estimate
Small LSP — the DSL has ~12 keywords, a handful of resolution targets. The server is mostly a lookup table. Hover + go-to-definition are the highest-value features; completions and diagnostics can follow.

## See also
- [[P - GenModel]]
- [[P - constrain]]
- [[P - Compound Generation]]
- Current TextMate grammar: `vscode/cambium-syntax/syntaxes/cambium.tmLanguage.json`
