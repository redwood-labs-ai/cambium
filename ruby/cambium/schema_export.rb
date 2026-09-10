# frozen_string_literal: true

# Canonical definition of "is this schema exported?" — Ruby MIRROR
# (DEC-001, issues #210/#212). `cli/schema-export.mjs` is the canonical
# JS-side implementation; this file is a deliberate, pattern-for-pattern
# port. Agreement between the two is enforced by the parity test over
# `packages/cambium/tests/fixtures/schema-export-corpus.json` (see
# `packages/cambium/tests/schema_export_parity.test.ts`) — never edit
# one side without the other; the corpus test will go red.
#
# See `cli/schema-export.mjs`'s doc comment for the full fail-safe
# rationale (DEC-158-007 lineage) and the tri-state contract
# (DEC-002/003):
#   'exported'   — a pattern positively matched.
#   'absent'     — no pattern matched, and the file's export set IS
#                  knowable (no `export *`).
#   'unknowable' — the file re-exports via `export * [as ns] from
#                  '...'`; its export set cannot be determined by regex
#                  at all.
# `compile.rb` and `pipeline.rb` (this module's callers) raise ONLY on
# 'absent' — 'unknowable' proceeds and defers enforcement to the
# runner's own-property lookup / serve's boot preflight (DEC-003).
#
# Ruby surface stays stdlib-only (CLAUDE.md § Dependency policy) — this
# file requires nothing beyond the Ruby core `Regexp`/`String` API
# already available without a `require`.
module Cambium
  module SchemaExport
    # Pattern C (DEC-004): a top-level `export *` (bare re-export or
    # `export * as ns from '...'`) means this file's export set cannot
    # be proven by regex — checked FIRST, before the name-specific
    # patterns.
    STAR_EXPORT_RE = /^\s*export\s*\*/.freeze

    # AUD-F1: Ruby's `^` treats only `\n` as a line separator, while JS's
    # `^` (with `/m`, used by STAR_EXPORT_RE and declarationPattern's
    # mirror below) also treats U+2028, U+2029, and a bare `\r` as line
    # terminators. Normalizing every alternate line terminator to `\n` up
    # front collapses the "which bytes start a line" question to one
    # explicit step both languages agree on, rather than leaning on each
    # regex engine's own (divergent) LineTerminator definition.
    LINE_TERMINATOR_RE = /\r\n|\r| | /.freeze

    # Generic (non-name-specific) forms of patterns A/B for discovery
    # (DEC-005) — same two patterns as `classify`, but capturing
    # whatever identifier they find rather than testing for one we
    # already know.
    #
    # AUD-F2: `(?a)` forces ASCII-only `\w`/`\b` semantics. Ruby's
    # default `\w` is Unicode-letter-aware for UTF-8 content; JS's `\w`
    # is always ASCII-only (no `u`/`\p{...}` escapes are used on that
    # side) — without `(?a)`, a target name immediately abutting a
    # non-ASCII letter (e.g. `Widgetα`) would match this pattern's
    # trailing `\b` in Ruby but not in JS.
    DECLARATION_NAME_RE = /(?a)^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?
      (?:const|let|var|class|function|type|interface|enum|namespace)\s+
      ([A-Za-z_$][\w$]*)\b/x.freeze
    EXPORT_LIST_RE = /export\s*\{([^}]*)\}/.freeze

    module_function

    # normalize_line_endings(content) → content, with every alternate
    # line-terminator byte collapsed to `\n` (AUD-F1; see
    # LINE_TERMINATOR_RE above).
    def normalize_line_endings(content)
      content.gsub(LINE_TERMINATOR_RE, "\n")
    end

    # classify(content, name) → 'exported' | 'absent' | 'unknowable'
    #
    # The tri-state answer to "is `name` exported from this file?"
    def classify(content, name)
      content = normalize_line_endings(content)
      return 'unknowable' if content.match?(STAR_EXPORT_RE)

      n = Regexp.escape(name)
      # AUD-F2 (follow-up): `(?a)` forces ASCII-only `\w`/`\b` semantics,
      # matching DECLARATION_NAME_RE's rationale above — the export-list
      # pattern's trailing `\b` has the identical divergence (a name
      # abutting a non-ASCII letter inside `export { … }`).
      export_list = /(?a)export\s*\{[^}]*\b#{n}\b[^}]*\}/
      # AUD-F2: `(?a)` forces ASCII-only `\w`/`\b` semantics, matching
      # DECLARATION_NAME_RE above — see its comment for the rationale.
      declaration = /(?a)^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?
        (?:const|let|var|class|function|type|interface|enum|namespace)\s+
        #{n}\b/x

      return 'exported' if content.match?(export_list) || content.match?(declaration)

      'absent'
    end

    # exported_or_unknowable?(content, name) → boolean
    #
    # The convenience boolean (DEC-002) for a caller whose destructive
    # act is appending — 'exported' and 'unknowable' both mean "don't
    # touch this file for this name." Ruby callers (the compiler,
    # pipeline validation) don't append; they only need the tri-state
    # for classify. Kept for parity with the JS module's public API and
    # for any future Ruby caller that needs the same convenience.
    def exported_or_unknowable?(content, name)
      verdict = classify(content, name)
      verdict == 'exported' || verdict == 'unknowable'
    end

    # list_exports(content) → [names]
    #
    # Export DISCOVERY (DEC-005) — best-effort DX, not enforcement.
    # Returns every name pattern A or pattern B can see, in the order
    # encountered (declarations first, then export-list entries). `X as
    # Y` aliasing yields `Y`. A file that is 'unknowable' (contains
    # `export *`) still returns whatever names ARE visible.
    def list_exports(content)
      content = normalize_line_endings(content)
      names = []
      seen = {}
      add = lambda do |name|
        next if name.nil? || name.empty? || seen[name]

        seen[name] = true
        names << name
      end

      content.scan(DECLARATION_NAME_RE) { |m| add.call(m[0]) }
      content.scan(EXPORT_LIST_RE) do |m|
        m[0].split(',').each do |raw_item|
          item = raw_item.strip
          next if item.empty?

          alias_match = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
          add.call(alias_match ? alias_match[2] : item)
        end
      end
      names
    end
  end
end
