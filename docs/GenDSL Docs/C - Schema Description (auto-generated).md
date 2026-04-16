# Compilation: Schema Description (auto-generated)

**Doc ID:** gen-dsl/compiler/schema-description

## Purpose
Auto-generate human-readable schema descriptions from TypeBox contracts and inject them into the system prompt. This tells the model the exact output shape on the first try, dramatically reducing repair calls.

## The problem
Without a schema description, the model guesses the nested structure:
- Outputs plain strings where objects are expected
- Invents field names (`p95_latency_start_ms` instead of `latency_ms_samples`)
- Misses required fields, adds extra keys

Each wrong guess costs a repair call (~1,000-1,500 tokens, ~20-30 seconds).

## The solution
The runner walks the TypeBox schema at runtime and produces a readable description:

```
SCHEMA (output must match this structure exactly):
- summary (string, required)
- metrics (object, required):
  - latency_ms_samples (array, required): each item is a number
  - avg_latency_ms (number, optional)
- key_facts (array, required): each item is an object (see below)
  each item:
    - fact (string, required)
    - citations (array, optional): each item is an object (see below)
      each item:
        - doc_id (string, required)
        - chunk_id (string, required)
        - quote (string, optional)
No extra keys. additionalProperties is false at every level.
```

Cost: ~80 tokens. Savings: 1,000+ tokens in avoided repairs.

## Semantics (normative)
- Schema descriptions MUST be auto-generated from the TypeBox contract. Authors do not write them.
- The description MUST include: field name, type, required/optional status.
- Nested structures MUST be indented and shown inline.
- The description is injected into both generate and repair system prompts.
- The closing footer MUST reflect the schema's actual `additionalProperties` state per object level — it is derived from the schema, not hardcoded.

## Opt-in open shape (RED-211)

By convention Cambium contracts set `additionalProperties: false` on every object level. That closes the shape and the prompt footer reads:

```
No extra keys. additionalProperties is false at every level.
```

For discovery-heavy tasks (scanning, exploration, extraction where the useful set of fields isn't fully predictable) an author can opt a specific object level — or the whole root — into open shape by setting `additionalProperties: true` in the TypeBox options:

```ts
export const ExplorationReport = Type.Object(
  {
    summary: Type.String(),
    metadata: Type.Object({ tag: Type.String() }, { additionalProperties: true }),
  },
  { additionalProperties: false, $id: 'ExplorationReport' },
)
```

The prompt footer then becomes:

```
Extra keys allowed at: /metadata. All other object levels are strict (additionalProperties: false).
```

If the root itself is open, the footer reads `Extra keys are allowed. Add fields the schema doesn't list if they are genuinely useful for the task.` AJV honours the setting at validation time, so the model's extras pass through instead of triggering repair.

**Default is strict.** Contracts without explicit `additionalProperties: false` inherit JSON Schema's permissive default — the runtime still works, but the prompt will say extras are allowed, which is usually not what you want. Existing contracts all close explicitly; new ones should too unless the task genuinely needs the opt-in.

## TypeBox as single source of truth
One TypeBox declaration derives four things:
1. **Model prompt schema** — the readable description (this feature)
2. **IR schema reference** — `returnSchemaId` linking the contract
3. **AJV validator** — compiled at runtime for validation + repair
4. **Structured output** — JSON Schema sent to providers that support xgrammar/response_format

No drift. No sync issues. One schema, four uses.

## Implementation
- `src/schema-describe.ts` — `describeSchema()` walks the schema tree, `schemaPromptBlock()` formats it for injection
- `src/step-handlers.ts` — `handleGenerate()` and `handleRepair()` include the block in system prompts

## See also
- [[D - Schemas (JSON Schema)]]
- [[C - Repair Loop]]
- [[P - returns]]
