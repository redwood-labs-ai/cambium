import { Type } from '@sinclair/typebox'

// NOTE: TypeBox schemas are JSON Schema by construction.

export const LogSummary = Type.Object(
  {
    key_events: Type.Array(
      Type.Object(
        {
          timestamp: Type.String(),
          message: Type.String(),
          severity: Type.Union([
            Type.Literal('info'),
            Type.Literal('warning'),
            Type.Literal('error'),
            Type.Literal('critical'),
          ]),
        },
        { additionalProperties: false }
      )
    ),
    error_count: Type.Number(),
    summary: Type.String(),
  },
  { additionalProperties: false, $id: 'LogSummary' }
)

export const GaiaAnswer = Type.Object(
  {
    reasoning: Type.String(),
    answer: Type.String(),
  },
  { additionalProperties: false, $id: 'GaiaAnswer' }
)

export const AnalysisReport = Type.Object(
  {
    summary: Type.String(),
    metrics: Type.Object(
      {
        latency_ms_samples: Type.Array(Type.Number()),
        avg_latency_ms: Type.Optional(Type.Number()),
      },
      { additionalProperties: false }
    ),
    key_facts: Type.Array(
      Type.Object(
        {
          fact: Type.String(),
          // v0.1: citations optional; we’ll enforce later when grounding lands.
          citations: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  doc_id: Type.String(),
                  chunk_id: Type.String(),
                  quote: Type.Optional(Type.String()),
                },
                { additionalProperties: false }
              )
            )
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false, $id: 'AnalysisReport' }
)

// ── Scanner Harness (spike) ──────────────────────────────────────────

export const PatternResult = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    description: Type.String(),
    severity: Type.Union([
      Type.Literal('critical'),
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
    ]),
    language: Type.String(),
    pattern: Type.Object(
      {
        regex: Type.String(),
        flags: Type.Optional(Type.String()),
        description: Type.String(),
      },
      { additionalProperties: false }
    ),
    test_cases: Type.Object(
      {
        matches: Type.Array(Type.String()),
        non_matches: Type.Array(Type.String()),
      },
      { additionalProperties: false }
    ),
    references: Type.Array(
      Type.Object(
        {
          url: Type.String(),
          title: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    linear_issue: Type.String(),
  },
  { additionalProperties: false, $id: 'PatternResult' }
)

export const IssueResearch = Type.Object(
  {
    vulnerability_class: Type.String(),
    cve_ids: Type.Array(Type.String()),
    detection_approaches: Type.Array(Type.String()),
    related_patterns: Type.Array(
      Type.Object(
        {
          description: Type.String(),
          regex_example: Type.Optional(Type.String()),
        },
        { additionalProperties: false }
      )
    ),
    research_summary: Type.String(),
  },
  { additionalProperties: false, $id: 'IssueResearch' }
)
