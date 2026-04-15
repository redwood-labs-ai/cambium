# Primitive: uses (tools)

**Doc ID:** gen-dsl/primitive/uses

## Purpose
Declare the tools a GenModel is allowed to call. Deny-by-default: a gen cannot invoke any tool it hasn't listed.

## Semantics (normative)

- Tools are **denied by default**.
- A run MUST NOT dispatch a tool that isn't in the gen's `uses` allowlist (enforced by `ToolRegistry.assertAllowed` at the dispatch site).
- Every tool call MUST be logged in the trace with typed input/output (`ToolCall` step).
- The runner validates each declared tool's `permissions` against the gen's `security` block at startup. A tool that needs capabilities the gen hasn't granted fails `SecurityCheck` before any generation runs. See [[S - Tool Sandboxing (RED-137)]].

## Example

```ruby
class WebResearcher < GenModel
  uses :web_search

  security :research_defaults     # pack grants network allowlist
  budget   :research_defaults     # pack caps per-tool calls
end
```

## How a tool is authored

Plugin tools live at `packages/<pkg>/app/tools/<name>.tool.json` (schema + permissions) paired with `<name>.tool.ts` (handler). Both are auto-discovered by the registry at startup. See [[D - Tools Registry]] for the handler shape and scaffolder CLI.

## Failure modes

- **Attempted call to undeclared tool** — `assertAllowed` throws; trace records the denial.
- **Input/output fails schema validation** — repair loop kicks in; see [[C - Repair Loop]].
- **Tool needs a capability the gen's `security` block doesn't grant** — `SecurityCheck` fails at startup with a pointer to the offending tool + permission.
- **Per-tool or per-run `budget` cap exceeded mid-loop** — the current call is refused with a `tool.budget.exceeded` trace event; the agentic loop terminates with a "force final output" turn rather than letting the model retry indefinitely.

## See also

- [[D - Tools Registry]]
- [[S - Tool Sandboxing (RED-137)]]
- [[P - Policy Packs (RED-214)]]
- [[C - Trace (observability)]]
