import { describe, it, expect } from 'vitest'
import { describeSchema, schemaPromptBlock } from './schema-describe.js'
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
  it('wraps description with header and footer', () => {
    const schema = Type.Object({ name: Type.String() })
    const block = schemaPromptBlock(schema)

    expect(block).toContain('SCHEMA (output must match this structure exactly)')
    expect(block).toContain('No extra keys')
    expect(block).toContain('name (string, required)')
  })
})
