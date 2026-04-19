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

// RED-215 phase 4: retro memory-agent output. A memory agent runs
// after the primary gen, reads its trace, and returns a list of
// structured writes that the primary runner commits to the
// corresponding memory buckets. The `memory` field names a slot
// declared on the primary gen (writes naming an unknown slot are
// dropped with a trace warning — this is a best-effort surface).
export const MemoryWrites = Type.Object(
  {
    writes: Type.Array(
      Type.Object(
        {
          memory: Type.String({
            description:
              'Name of the memory slot to append to. Must match a `memory :<name>` decl on the primary gen.',
          }),
          content: Type.String({
            description:
              'Free-form content to append. Rendered verbatim into the primary\'s Memory block on future runs.',
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, $id: 'MemoryWrites' },
)

// RED-260: Pattern Engineer agent schemas.
// Used by the pattern-engineer GenModel to add security patterns to redwood-scanner.

export const PatternProposal = Type.Object(
  {
    name: Type.String({ description: 'Human-readable pattern name' }),
    regex: Type.String({ description: 'JavaScript regex as a string, e.g. "/fetch\\s*\\([^)]+/g"' }),
    severity: Type.Union([
      Type.Literal('critical'),
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
    ]),
    message: Type.String({ description: 'One-line description of the security risk' }),
    fix: Type.String({ description: 'What to do instead of the dangerous pattern' }),
    fileTypes: Type.Optional(
      Type.Array(Type.String(), { description: "File extensions, e.g. ['.js', '.ts']" })
    ),
    safeContext: Type.Optional(
      Type.Array(Type.String(), { description: 'Strings that suppress false positives, e.g. ["path.join("]' })
    ),
    language: Type.String({
      description: 'Target language directory: javascript, python, ruby, go, rust, php, cpp, common, config',
    }),
    rationale: Type.String({ description: 'Why this pattern, what vulnerability it catches, CVE reference if any' }),
  },
  { additionalProperties: false, $id: 'PatternProposal' }
)

export const PatternTransaction = Type.Object(
  {
    branch: Type.String({ description: 'Git branch name, e.g. "RED-157/axios-ssrf"' }),
    pr_url: Type.Optional(Type.String({ description: 'Forgejo PR URL if created successfully' })),
    compare_url: Type.String({
      description: 'Forgejo compare URL for manual PR creation if FORGEJO_TOKEN is not configured',
    }),
    pattern_added: Type.String({ description: 'Name of the pattern that was added' }),
    language: Type.String({ description: 'Language directory the pattern was added to' }),
    tests_passed: Type.Boolean({ description: 'Whether npm test passed without regressions' }),
    test_output: Type.Optional(Type.String({ description: 'Relevant excerpt of test output' })),
    files_modified: Type.Array(Type.String(), { description: 'Files changed by this transaction' }),
    summary: Type.String({ description: 'One-paragraph summary of what was done' }),
  },
  { additionalProperties: false, $id: 'PatternTransaction' }
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
