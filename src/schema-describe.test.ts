import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { describeSchema, schemaPromptBlock, collectAdditionalProperties } from './schema-describe.js'
import { Type } from '@sinclair/typebox'

describe('describeSchema', () => {
  it('describes a flat object', () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Number(),
    }, { required: ['name'] })

    const desc = describeSchema(schema)
    expect(desc).toContain('name (string, required)')
    expect(desc).toContain('age (number, required)')
  })

  it('describes nested objects', () => {
    const schema = Type.Object({
      metrics: Type.Object({
        count: Type.Number(),
      }),
    })

    const desc = describeSchema(schema)
    expect(desc).toContain('metrics (object, required)')
    expect(desc).toContain('count (number, required)')
  })

  it('describes arrays with item types', () => {
    const schema = Type.Object({
      values: Type.Array(Type.Number()),
    })

    const desc = describeSchema(schema)
    expect(desc).toContain('values (array, required)')
    expect(desc).toContain('each item is a number')
  })

  it('describes arrays of objects with nested structure', () => {
    const schema = Type.Object({
      items: Type.Array(Type.Object({
        label: Type.String(),
      })),
    })

    const desc = describeSchema(schema)
    expect(desc).toContain('items (array, required)')
    expect(desc).toContain('each item:')
    expect(desc).toContain('label (string, required)')
  })

  it('marks optional fields', () => {
    const schema = Type.Object({
      required_field: Type.String(),
      optional_field: Type.Optional(Type.Number()),
    })

    const desc = describeSchema(schema)
    expect(desc).toContain('required_field (string, required)')
    expect(desc).toContain('optional_field')
    expect(desc).toContain('optional')
  })

  it('handles the AnalysisReport schema', async () => {
    const { AnalysisReport } = await import('../packages/cambium/src/contracts.ts')
    const desc = describeSchema(AnalysisReport)

    expect(desc).toContain('summary (string, required)')
    expect(desc).toContain('metrics (object, required)')
    expect(desc).toContain('latency_ms_samples (array, required)')
    expect(desc).toContain('key_facts (array, required)')
    expect(desc).toContain('fact (string, required)')
  })
})

describe('schemaPromptBlock', () => {
  it('wraps description with header', () => {
    const schema = Type.Object({ name: Type.String() }, { additionalProperties: false })
    const block = schemaPromptBlock(schema)

    expect(block).toContain('SCHEMA (output must match this structure exactly)')
    expect(block).toContain('name (string, required)')
  })

  it('says "No extra keys" when root is strict and all nested levels are strict', () => {
    const schema = Type.Object(
      {
        metrics: Type.Object({ count: Type.Number() }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    )
    const block = schemaPromptBlock(schema)
    expect(block).toContain('No extra keys')
    expect(block).toContain('additionalProperties is false at every level')
  })

  // RED-211: schema authors can opt into open shape when the model should be
  // free to add unexpected useful fields. The prompt must tell the model the
  // truth — the previous footer hard-coded "extras forbidden" regardless.
  it('says extras allowed when root is open', () => {
    const schema = Type.Object({ name: Type.String() }, { additionalProperties: true })
    const block = schemaPromptBlock(schema)
    expect(block).toContain('Extra keys are allowed')
    expect(block).not.toContain('No extra keys')
  })

  it('enumerates open paths when only part of the schema is open', () => {
    const schema = Type.Object(
      {
        metadata: Type.Object({ tag: Type.String() }, { additionalProperties: true }),
        strict_part: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      },
      { additionalProperties: false },
    )
    const block = schemaPromptBlock(schema)
    expect(block).toContain('Extra keys allowed at: /metadata')
    expect(block).toContain('All other object levels are strict')
  })

  it('treats unset additionalProperties as open (JSON Schema default)', () => {
    // A naked Type.Object with no options emits no additionalProperties key;
    // JSON Schema defaults to allowing extras, and the prompt should say so.
    const schema = Type.Object({ name: Type.String() })
    const block = schemaPromptBlock(schema)
    expect(block).not.toContain('No extra keys')
  })
})

// RED-211: end-to-end check that AJV honours the opt-in, so an author
// setting additionalProperties: true actually lets extras through at
// validation time. This is the behaviour the ticket asks to "respect."
describe('open-schema validation (RED-211)', () => {
  it('accepts extra keys when schema opts in', () => {
    const schema = Type.Object(
      { name: Type.String() },
      { additionalProperties: true, $id: 'OpenRoot' },
    )
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    expect(validate({ name: 'Ada', discovered_field: 42 })).toBe(true)
  })

  it('rejects extra keys when schema is strict', () => {
    const schema = Type.Object(
      { name: Type.String() },
      { additionalProperties: false, $id: 'StrictRoot' },
    )
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    expect(validate({ name: 'Ada', discovered_field: 42 })).toBe(false)
  })
})

describe('collectAdditionalProperties', () => {
  it('records the state at every object level, including array items', () => {
    const schema = Type.Object(
      {
        items: Type.Array(
          Type.Object({ tag: Type.String() }, { additionalProperties: true }),
        ),
      },
      { additionalProperties: false },
    )
    const collected = collectAdditionalProperties(schema)
    const root = collected.find(c => c.path === '/')
    const itemLevel = collected.find(c => c.path === '/items[]')
    expect(root?.value).toBe(false)
    expect(itemLevel?.value).toBe(true)
  })
})
