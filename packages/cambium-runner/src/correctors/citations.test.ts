import { describe, it, expect } from 'vitest'
import { citations } from './citations.js'

const doc = `Incident: API latency regression.

Timeline:
- 10:01 - p95 latency 120 ms
- 10:05 - p95 latency 140 ms

Hypothesis: cache stampede after deploy.`

describe('citations corrector', () => {
  it('passes when quotes match the document', () => {
    const data = {
      key_facts: [{
        fact: 'API latency regression',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'API latency regression.' }],
      }],
    }
    const result = citations(data, { document: doc })
    const errors = result.issues.filter(i => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('flags fabricated quotes', () => {
    const data = {
      key_facts: [{
        fact: 'Something happened',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'This text does not exist in the document at all.' }],
      }],
    }
    const result = citations(data, { document: doc })
    const errors = result.issues.filter(i => i.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('not found in source document')
  })

  it('flags missing citations', () => {
    const data = {
      key_facts: [{
        fact: 'A fact without citations',
        citations: [],
      }],
    }
    const result = citations(data, { document: doc })
    expect(result.issues.some(i => i.message.includes('Missing citations'))).toBe(true)
  })

  it('flags absent citations field', () => {
    const data = {
      key_facts: [{
        fact: 'A fact without citations field',
      }],
    }
    // The corrector only checks objects that have a citations key
    // Items without the key are caught by schema validation instead
    const result = citations(data, { document: doc })
    // No error from citations corrector — schema validation handles this
    expect(result.issues).toHaveLength(0)
  })

  it('handles fuzzy matching (whitespace differences)', () => {
    const data = {
      key_facts: [{
        fact: 'test',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'cache stampede   after deploy' }],
      }],
    }
    const result = citations(data, { document: doc })
    const errors = result.issues.filter(i => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('handles case-insensitive matching', () => {
    const data = {
      key_facts: [{
        fact: 'test',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'CACHE STAMPEDE AFTER DEPLOY' }],
      }],
    }
    const result = citations(data, { document: doc })
    const errors = result.issues.filter(i => i.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('does not mutate original data', () => {
    const data = {
      key_facts: [{
        fact: 'test',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'fabricated' }],
      }],
    }
    const original = JSON.parse(JSON.stringify(data))
    citations(data, { document: doc })
    expect(data).toEqual(original)
  })

  it('never sets corrected to true (flag only)', () => {
    const data = {
      key_facts: [{
        fact: 'test',
        citations: [{ doc_id: 'doc', chunk_id: 'c1', quote: 'fabricated nonsense' }],
      }],
    }
    const result = citations(data, { document: doc })
    expect(result.corrected).toBe(false)
  })
})
