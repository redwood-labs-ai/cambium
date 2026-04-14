import { Type } from '@sinclair/typebox'

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
