# Data: Tools Registry

**Doc ID:** gen-dsl/data/tools-registry

## Purpose
Central registry of tools callable by a gen's runner. Loaded at runner startup; discovered from the filesystem.

## Layout (post-RED-209)

Plugin tools live as paired files in `packages/<pkg>/app/tools/`:

```
app/tools/
  my_tool.tool.json   # schema + permissions (discovered)
  my_tool.tool.ts     # handler (discovered + dynamic-imported)
```

The registry walks the directory and, for each `.tool.json`, looks for a sibling `.tool.ts` (or `.tool.js`) and imports its `execute(input, ctx?)` export. No edits to `src/tools/index.ts` or the registry itself are required.

Framework-provided "batteries-included" tools (calculator, read_file, web_search, web_extract, execute_code) live in `src/builtin-tools/` in the same paired-file layout as app tools (RED-221). The runner loads `src/builtin-tools/` first, then `packages/<pkg>/app/tools/`. `Map.set` overwrites on name collision, so app tools automatically shadow framework builtins — that's the override hook.

## Semantics

- Each tool MUST declare `name`, `description`, `inputSchema`, and `outputSchema` in its `.tool.json`.
- Tools SHOULD declare `permissions` honestly. A tool that calls `ctx.fetch` MUST declare `permissions: { network: true, network_hosts: [...] }`; a tool declaring `pure: true` MUST NOT touch the network/filesystem/exec.
- Dispatch precedence: a plugin handler (`registry.getHandler(name)`) wins over any same-named framework builtin (`builtinTools[name]`). This is the extension point apps use to ship their own versions of a builtin.
- Tool calls MUST be mediated by the gen's `security` + `budget` policy. See [[S - Tool Sandboxing (RED-137)]].

## Handler shape

```ts
import type { ToolContext } from '../../../../src/tools/tool-context.js';

export async function execute(
  input: { /* matches inputSchema */ },
  ctx?: ToolContext,
): Promise<{ /* matches outputSchema */ }> {
  // If this tool needs network: use ctx.fetch, NOT globalThis.fetch.
  // The SSRF guard lives on ctx.fetch.
}
```

## Scaffolding a new tool

- Deterministic: `cambium new tool <name>` — emits a stub with `pure: true` and paired files in the RED-209 layout.
- Agentic: `cambium new tool --describe "<what it does>"` (RED-216) — runs the `ToolScaffold` gen to infer name, schemas, permissions, and handler source from a natural-language description.

## See also
- [[P - uses (tools)]]
- [[S - Tool Sandboxing (RED-137)]]
- [[C - Runner (TS runtime)]]
