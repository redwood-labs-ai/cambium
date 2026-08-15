# Primitive: constrain

**Doc ID:** gen-dsl/primitive/constrain

## Purpose
Declare constraints that shape generation behavior. Constraints are the primary mechanism for controlling *how* the runtime executes — like ORM options that change behavior without changing the interface.

## Semantics (normative)
- Constraints SHOULD compile into system/policy directives or runtime behavior changes.
- Constraints MUST NOT silently override schema requirements.
- Constraints flow into `ir.policies.constraints` and are read by the runner.

## Categories

### Prompt-level constraints
Shape the model's output via system prompt directives.

```ruby
constrain :tone, to: :professional
constrain :length, max_tokens: 2000
```

### Compound generation constraints
Change the runtime execution strategy for higher reliability. See [[P - Compound Generation]].

```ruby
constrain :compound, strategy: :review       # LLM reviews output against source
constrain :consistency, passes: 2            # generate N times, compare, consensus
```

## Deprecated: `constrain :budget`

`constrain :budget, max_tool_calls: N, max_duration: "5m"` is deprecated. Use the `budget` primitive instead:

```ruby
budget per_run: { max_calls: 10, max_tokens: 5000, max_duration: "5m" }
```

The `constrain :budget` form writes into `policies.constraints.budget` in the IR; the runner emits a one-time stderr warning when it encounters this shape. It will be removed in Cambium 1.0. See also [[P - Policy Packs (RED-214)]] § Budget.

## See also
- [[P - generate]]
- [[P - Compound Generation]]
- [[C - IR (Intermediate Representation)]]
