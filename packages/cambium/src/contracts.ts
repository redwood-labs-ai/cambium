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

export const WebResearchResult = Type.Object(
  {
    summary: Type.String(),
    sources: Type.Array(
      Type.Object(
        {
          title: Type.String(),
          url: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false, $id: 'WebResearchResult' }
)

// RED-216: agentic tool scaffolder output.
// The gen produces a typed plan for a new plugin tool; the CLI writes
// it to disk on user confirm.
export const ToolScaffoldResult = Type.Object(
  {
    name: Type.String({
      description: 'snake_case identifier used in `uses :<name>` and for file names',
    }),
    description: Type.String({
      description: 'one-sentence description shown to the model when it decides whether to call the tool',
    }),
    permissions: Type.Object(
      {
        pure: Type.Optional(Type.Boolean()),
        network: Type.Optional(Type.Boolean()),
        network_hosts: Type.Optional(Type.Array(Type.String())),
        filesystem: Type.Optional(Type.Boolean()),
        filesystem_paths: Type.Optional(Type.Array(Type.String())),
        exec: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false }
    ),
    input_schema: Type.Object(
      {
        type: Type.Literal('object'),
        required: Type.Optional(Type.Array(Type.String())),
        properties: Type.Record(Type.String(), Type.Unknown()),
        additionalProperties: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false }
    ),
    output_schema: Type.Object(
      {
        type: Type.Literal('object'),
        required: Type.Optional(Type.Array(Type.String())),
        properties: Type.Record(Type.String(), Type.Unknown()),
        additionalProperties: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false }
    ),
    handler_typescript: Type.String({
      description: 'Full TS source for <name>.tool.ts — imports, types, execute function. Must export async function execute(input, ctx?).',
    }),
    rationale: Type.String({
      description: 'One-paragraph explanation of why the chosen permissions and schemas are right for the described task',
    }),
  },
  { additionalProperties: false, $id: 'ToolScaffoldResult' }
)
