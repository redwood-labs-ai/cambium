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

// ── Cambium CI Review POC (RED-381) ─────────────────────────────────
// A Cambium-aware pipeline that reviews PRs against the Cambium repo
// itself. Two stages: CambiumDiffAnalyzer classifies the diff into
// Cambium-flavored subsystem labels + risk categories + key excerpts;
// CambiumPrReviewer reasons from the structured analysis to produce
// a typed review (concerns + verdict).
//
// Lives in this repo as a real, runnable pipeline — not a fixture.
// See `app/pipelines/cambium_ci_review.pipeline.rb`.

/** Raw PR diff text (the input to the pipeline). String shape — the
 *  Cambium-aware semantics live in the diff content itself, not in a
 *  pre-structured envelope. */
export const PullRequestDiff = Type.String({
  $id: 'PullRequestDiff',
  description: 'Unified-diff output for a Cambium PR.',
})

const CAMBIUM_SURFACE = Type.Union(
  [
    Type.Literal('ruby_dsl'),         // ruby/cambium/runtime.rb, ruby/cambium/pipeline.rb
    Type.Literal('compile_rb'),       // ruby/cambium/compile.rb
    Type.Literal('ts_runner'),        // packages/cambium-runner/src/runner.ts + pipeline.ts
    Type.Literal('step_handlers'),    // packages/cambium-runner/src/step-handlers.ts
    Type.Literal('trace'),            // trace shape / step types
    Type.Literal('tool_dispatch'),    // tools/* / step dispatch sites (cambium-security territory)
    Type.Literal('exec_substrate'),   // exec sandboxing (wasm/firecracker/native)
    Type.Literal('memory'),           // memory subsystem
    Type.Literal('cron'),             // schedule subsystem
    Type.Literal('log'),              // log primitive / sinks
    Type.Literal('serve'),            // serve mode (HTTP)
    Type.Literal('cli'),              // cli/cambium.mjs + subcommand .mjs files
    Type.Literal('scaffolder'),       // cli/generate.mjs
    Type.Literal('lint'),             // cli/lint.mjs
    Type.Literal('vscode_extension'), // vscode/cambium-syntax/
    Type.Literal('docs'),             // docs/, README.md, CLAUDE.md
    Type.Literal('tests_only'),       // *.test.ts / *.test.rb changes only
    Type.Literal('build_or_ci'),      // package.json, CI configs, scripts/
    Type.Literal('other'),
  ],
  { description: 'Coarse-grained Cambium subsystem labels.' },
)

// ── Deterministic touched-surface floor (#233) ──────────────────────
// `CambiumDiffAnalyzer` (the LLM stage) has produced `touched_surfaces`
// lists that silently drop a surface the diff plainly touches (#231 —
// a docs-only PR reviewed as if it carried no docs). The fix is a floor,
// not a lower-probability prompt: the CI workflow computes this same
// classification from the changed-file paths and the review consumes
// the UNION of the two lists — deterministic labels can never be
// dropped; the model may still ADD labels a path alone can't reveal
// (`trace`, most obviously).
//
// The rules below are the executable form of the comments on
// `CAMBIUM_SURFACE` above (one source, not a second copy — DEC-006;
// the #210 failure mode was five disagreeing definitions of one
// concept). Where a comment above only named a directory in prose
// (`tool_dispatch` — "tools/* / step dispatch sites"), the rule here
// uses the concrete path `cambium_diff_analyzer.system.md` already
// committed to for the same label, so the two descriptions of "what
// counts as tool_dispatch" don't drift apart either.
//
// First matching rule wins, so a more specific prefix (`cli/generate.mjs`)
// must be listed before a broader one that would also match it (`cli/`).
const CAMBIUM_SURFACE_PATH_RULES: ReadonlyArray<{ surface: string; test: (path: string) => boolean }> = [
  { surface: 'ruby_dsl', test: (p) => p === 'ruby/cambium/runtime.rb' || p === 'ruby/cambium/pipeline.rb' },
  { surface: 'compile_rb', test: (p) => p === 'ruby/cambium/compile.rb' },
  { surface: 'cron', test: (p) => p === 'ruby/cambium/cron.rb' },
  { surface: 'ts_runner', test: (p) => p === 'packages/cambium-runner/src/runner.ts' || p === 'packages/cambium-runner/src/pipeline.ts' },
  { surface: 'step_handlers', test: (p) => p === 'packages/cambium-runner/src/step-handlers.ts' },
  { surface: 'tool_dispatch', test: (p) => p.startsWith('packages/cambium-runner/src/tools/') },
  { surface: 'exec_substrate', test: (p) => p.startsWith('packages/cambium-runner/src/exec-substrate/') },
  { surface: 'memory', test: (p) => p.startsWith('packages/cambium-runner/src/memory/') },
  { surface: 'log', test: (p) => p.startsWith('packages/cambium-runner/src/log/') },
  { surface: 'serve', test: (p) => p.startsWith('packages/cambium-runner/src/serve/') },
  { surface: 'scaffolder', test: (p) => p === 'cli/generate.mjs' },
  { surface: 'lint', test: (p) => p === 'cli/lint.mjs' },
  { surface: 'cli', test: (p) => p.startsWith('cli/') },
  { surface: 'vscode_extension', test: (p) => p.startsWith('vscode/cambium-syntax/') },
  { surface: 'docs', test: (p) => p.startsWith('docs/') || p === 'README.md' || p === 'CLAUDE.md' },
  {
    surface: 'build_or_ci',
    test: (p) =>
      p === 'package.json' ||
      p === 'package-lock.json' ||
      p.startsWith('.forgejo/') ||
      p.startsWith('.github/') ||
      p.startsWith('scripts/'),
  },
]

/** True for Cambium's test-file naming convention (`*.test.ts` / `*.test.rb`).
 *  Exported so `classifyTouchedSurfaces`'s `tests_only` handling and its
 *  own unit test share one definition. */
export function isCambiumTestPath(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.test.rb')
}

/**
 * Deterministic floor for `touched_surfaces` (#233). Maps a list of
 * changed file paths (repo-root-relative, UNQUOTED — i.e. `git diff
 * --name-only -z` shape, NUL-split by the caller, NOT plain `--name-only`
 * shape, which C-quotes any path with a byte outside 0x20-0x7e/`"`/`\`
 * and would otherwise break every `startsWith(...)` rule below on quoted
 * paths — AUD-001) to the coarse-grained `CAMBIUM_SURFACE` labels above.
 * Consumed by `.forgejo/workflows/ci-review.yml` (via
 * `scripts/ci-review-input.mjs`) to compute the surfaces
 * `CambiumPrReviewer` treats as PROVEN touched — unioned with, never
 * overridden by, whatever `CambiumDiffAnalyzer`'s own `touched_surfaces`
 * adds.
 *
 * OQ-001 — `tests_only` is a WHOLE-SET predicate ("every changed file is
 * a test"), not a per-file label, so a per-path rule table can't express
 * it (there is no single path whose presence proves the *rest* of the
 * diff is tests too). It is computed here as a separate pass rather than
 * omitted from the floor: an all-test-files PR is exactly the case a
 * deterministic floor should get right without waiting on the model.
 * Empty input maps to no surfaces at all (not `['tests_only']` vacuously).
 *
 * A path matching no rule maps to `other` rather than being dropped — a
 * coarse label beats a missing one, matching the enum's own `other`
 * fallback intent.
 */
export function classifyTouchedSurfaces(changedPaths: string[]): string[] {
  const surfaces = new Set<string>()
  for (const path of changedPaths) {
    const rule = CAMBIUM_SURFACE_PATH_RULES.find((r) => r.test(path))
    surfaces.add(rule ? rule.surface : 'other')
  }
  if (changedPaths.length > 0 && changedPaths.every(isCambiumTestPath)) {
    surfaces.add('tests_only')
  }
  return Array.from(surfaces).sort()
}

/** The deterministic floor's shape as a pipeline `input` slot — a plain
 *  array of `CAMBIUM_SURFACE` labels, no wrapping envelope. See
 *  `input :surfaces, schema: CambiumTouchedSurfaces` on
 *  `CambiumCiReview` (`app/pipelines/cambium_ci_review.pipeline.rb`). */
export const CambiumTouchedSurfaces = Type.Array(CAMBIUM_SURFACE, {
  $id: 'CambiumTouchedSurfaces',
  description: 'Deterministic touched-surface floor computed from the PR\'s changed file paths (#233).',
})

const CAMBIUM_RISK = Type.Union(
  [
    Type.Literal('new_dsl_primitive'),         // needs cambium-docs parity
    Type.Literal('new_ir_field'),              // needs C - IR doc update
    Type.Literal('new_trace_step_type'),       // needs C - Trace doc update
    Type.Literal('tool_dispatch_change'),      // cambium-security territory
    Type.Literal('exec_substrate_change'),     // cambium-security territory
    Type.Literal('memory_scope_or_strategy'),  // memory invariant surface
    Type.Literal('public_export_change'),      // package API surface
    Type.Literal('wire_format_change'),        // serve mode wire compat
    Type.Literal('dependency_change'),         // supply-chain audit territory
    Type.Literal('compile_time_validation'),   // breaking change for existing IRs
    Type.Literal('none'),
  ],
  { description: 'Risk categories that flag concerns the reviewer should check against the Cambium invariants in CLAUDE.md.' },
)

/** Stage 1 output: structured classification of the diff. */
export const CambiumDiffAnalysis = Type.Object(
  {
    summary: Type.String({
      description: 'One-paragraph plain-English summary of what the PR changes.',
    }),
    touched_surfaces: Type.Array(CAMBIUM_SURFACE, {
      description: 'Cambium subsystems the diff touches.',
    }),
    risk_categories: Type.Array(CAMBIUM_RISK, {
      description: 'Cambium-specific risk categories the reviewer should weight when reading the diff.',
    }),
    magnitude: Type.Union(
      [Type.Literal('trivial'), Type.Literal('small'), Type.Literal('medium'), Type.Literal('large')],
      { description: 'Rough sizing — informs reviewer depth. Trivial: typo/whitespace. Small: ≤50 lines, one surface. Medium: multiple files, one subsystem. Large: multi-subsystem or DSL/IR change.' },
    ),
    files_changed: Type.Number({
      description: 'Count of files touched in the diff.',
    }),
    key_excerpts: Type.Array(
      Type.Object(
        {
          file: Type.String(),
          context: Type.String({
            description: 'A short snippet of code from the diff that illustrates a flagged risk or surface change.',
          }),
          risk: Type.String({
            description: 'Which risk category this excerpt relates to (free-text; matches a value from risk_categories or describes the concern).',
          }),
        },
        { additionalProperties: false },
      ),
      { description: 'Diff snippets the reviewer should focus on.' },
    ),
  },
  { additionalProperties: false, $id: 'CambiumDiffAnalysis' },
)

/** Stage 2 output: typed review verdict. */
export const CambiumCiReview = Type.Object(
  {
    summary: Type.String({
      description: 'One-paragraph reviewer summary suitable for posting as a PR review comment.',
    }),
    concerns: Type.Array(
      Type.Object(
        {
          severity: Type.Union([
            Type.Literal('blocking'),
            Type.Literal('suggestion'),
            Type.Literal('nit'),
          ]),
          category: Type.String({
            description: 'Free-text label (e.g. "docs-drift", "security-invariant", "test-coverage", "ir-shape").',
          }),
          message: Type.String(),
          file: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    overall_verdict: Type.Union(
      [
        Type.Literal('approve'),
        Type.Literal('approve_with_suggestions'),
        Type.Literal('request_changes'),
      ],
      { description: 'Reviewer verdict mirroring GitHub PR review states.' },
    ),
  },
  { additionalProperties: false, $id: 'CambiumCiReview' },
)
