# RED-214: Named Policy Packs

**Doc ID:** gen-dsl/primitives/policy-packs
**Status:** Design draft → implementation in progress
**Depends on:** [[S - Tool Sandboxing (RED-137)]]

## Motivation

After RED-137, the `security network: {...}` and `budget` blocks work,
but gens that share a mission shape (research, log analysis, code
review) repeat the same allowlist/budget boilerplate. The opinionated
move: bundle them into named **policy packs** that a gen references by
symbol, the same way `system :analyst` resolves to a file.

```ruby
# Before — repeated in every research gen:
security network: { allowlist: %w[api.tavily.com api.exa.ai] }
budget   per_tool: { web_search: { max_calls: 5 } },
         per_run:  { max_calls: 20 }

# After — one declaration of intent:
security :research_defaults
budget   :research_defaults
```

The gen reads as a *declaration of intent* ("this is a research agent")
rather than a tuning panel. The pack owns the values.

## Pack file shape

`packages/cambium/app/policies/<name>.policy.rb` — top-level Ruby DSL.
One file = one pack. Same convention as `.system.md` files.

```ruby
# app/policies/research_defaults.policy.rb

# Hosts and defenses for research-style agents.
# Tavily for general web search; Exa for neural search.
network \
  allowlist: %w[api.tavily.com api.exa.ai]

# Conservative caps — research budgets are tight on purpose.
budget \
  per_tool: { web_search: { max_calls: 5 } },
  per_run:  { max_calls: 20 }
```

A pack can declare any subset of `network`, `filesystem`, `exec`, and
`budget`. Slots not declared by the pack stay empty when used.

Why Ruby and not JSON: comments, computed values, consistency with
`.cmb.rb`. JSON would need a parallel parser and we'd lose the ability
to explain *why* a host is allowed.

## Reference shape from a gen — "named imports from a pack"

Mental model: a pack is a small module with named exports
(`network`, `filesystem`, `exec`, `budget`, future…). Each primitive
call pulls the matching export. This is conceptually:

```js
// pseudo-equivalent
import { security as research_security,
         budget   as research_budget } from '@policies/research_defaults'
```

In Cambium DSL:

```ruby
# Pull the security export (network/filesystem/exec) from the pack:
security :research_defaults

# Pull the budget export from the pack:
budget :research_defaults

# Inline form still works — RED-137 escape hatch:
security network: { allowlist: ["api.example.com"] }
```

V1 ships per-export imports only. A combined `policy :research_defaults`
("import all exports from the pack") is a clean v2 sugar — it would
expand to `security :research_defaults` + `budget :research_defaults` +
whatever else packs end up exporting. No design decisions blocked by
deferring it; we can add it the moment we have two packs and someone
copies-pastes the two-line invocation.

If a gen calls `security :foo` against a pack that doesn't export
`security` (only declares `budget`), that's a compile-time error —
asking for an export the pack doesn't have.

## Mixing rules (per-slot, not per-primitive)

The pack contributes per *slot* (`network`, `filesystem`, `exec`,
`budget.per_tool`, `budget.per_run`). A gen can fill in slots the pack
didn't define, but cannot also touch a slot the pack did define.
Concretely:

```ruby
# Pack `research_defaults` declares: network + (no filesystem) + (no exec)
#                                    + budget.per_tool web_search + per_run

security :research_defaults
security exec: { allowed: true }     # ✓ pack didn't touch exec — fine

security :research_defaults
security network: { allowlist: [...] }  # ✗ pack defined network — error
```

The compile-time check is: "for each slot in the gen's resolved
security/budget, did exactly one source set it?" Two sources for the
same slot is an error.

This gives gens room to *extend* without making merge precedence
ambiguous. To get "almost the pack but with one tweak," copy the pack
to a new file (`research_internal.policy.rb`) and tweak. The cost is a
few duplicated lines; the benefit is no merge-rule lawyering.

Deep-merge with inline override on the same slot is a deliberate
follow-up once usage shows it earns its complexity.

## IR shape

When a gen uses a pack, the IR carries both the resolved values (so
the runtime needs no changes) **and** the pack name (so the trace and
lints can cite the source).

```jsonc
{
  "policies": {
    "security": {
      "_pack": "research_defaults",
      "network": { "allowlist": ["api.tavily.com", "api.exa.ai"], ... }
    },
    "budget": {
      "_pack": "research_defaults",
      "per_tool": { "web_search": { "max_calls": 5 } },
      "per_run":  { "max_calls": 20 }
    }
  }
}
```

`_pack` is a reserved key. The TS-side `buildSecurityPolicy` and
`parseBudget` already ignore unknown keys, so no runtime changes are
strictly required — but the trace step and any audit code should
surface `_pack` in their output.

## Compile-time errors

- Pack referenced by a gen but no `<name>.policy.rb` file exists:
  `Policy pack 'research_defaults' not found. Looked for: app/policies/research_defaults.policy.rb`
- Pack file declares an unknown top-level directive (typo for `network`):
  `Unknown directive 'netwrk' in pack 'research_defaults'`
- Gen asks for an export the pack doesn't provide:
  `Pack 'research_defaults' does not export 'security' (only declares: budget)`
- Two sources set the same slot (pack + inline both touch network):
  `security: slot 'network' is set by both pack ':research_defaults' and inline. Pick one source per slot.`

## VS Code

- Completions for `security ` and `budget ` after the keyword include
  the names of every `app/policies/*.policy.rb` file (filesystem scan
  at LSP load).
- Hover on `security :research_defaults` shows the pack file's
  contents.
- Go-to-definition jumps to the pack file. (Lift the same machinery
  used for `system :foo`.)

## Lint

`cambium lint` warns on:
- Pack files that no gen references (dead pack).
- Two packs whose `network.allowlist` are identical (duplicate intent).
- Pack files that declare zero of the four slots (empty pack).

Lint is a separate ticket if too much for this one — file as RED-XXX
follow-up if we punt.

## Out of scope for this ticket

- **Inline override of a pack-defined slot.** Deferred until we see
  how packs are actually used. Today: per-slot, exactly one source.
  Filling in slots the pack didn't define is fine; overriding ones it
  did is an error.
- **Combined `policy :name` ("import all exports").** Deferred. Pure
  sugar over `security :name` + `budget :name`; no design decisions
  blocked. Lands the moment two packs exist and someone copy-pastes.
- **Symbol arrays** (`allowlist: [:research_defaults_hosts, "api.x.com"]`
  — packs that contribute to a list rather than replacing it). Tempting,
  complicated, premature.
- **Cross-package pack discovery.** V1 looks in the gen's own package
  only (just like `.system.md` resolution).
- **Pack inheritance / composition.** No `extends:`. Copy if you need it.

## Acceptance criteria mapping

From the Linear ticket:
- ✓ DSL primitive (symbol-resolution on existing `security`/`budget`)
- ✓ IR shape (`_pack` metadata)
- ✓ Runtime parsing (existing `buildSecurityPolicy` / `parseBudget`
  already accept the resolved shape; they ignore `_pack`)
- ✓ VS Code completions that know pack names
- ⚠ Lint that warns on unused packs — separate ticket if we punt
- ✓ RED-137 inline form stays as the escape hatch

## Implementation phases

1. Design note (this doc).
2. Ruby DSL: `PolicyPack` loader + symbol resolution in `security`/`budget`.
3. Compiler integration + clear errors.
4. IR `_pack` metadata + trace `SecurityCheck` step shows it.
5. Test-drive: `app/policies/research_defaults.policy.rb` + migrate
   `web_researcher.cmb.rb` to use it. Run end-to-end.
6. VS Code completions/hover/go-to-def for pack names.
7. `cambium-security` agent review on the diff.

Each phase is one commit; the test-drive commit is the integration
proof.
