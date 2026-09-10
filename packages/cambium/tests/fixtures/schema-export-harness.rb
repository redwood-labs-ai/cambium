# frozen_string_literal: true

# STEP-004 parity harness (DEC-008) — spawned ONCE by
# `schema_export_parity.test.ts` for the whole corpus (4-core CI budget;
# no per-fixture spawn). Reads the corpus JSON array from stdin, runs
# `Cambium::SchemaExport.classify` / `.list_exports` over every entry,
# and prints a JSON array of `{ verdict, exports }` results to stdout —
# one result per corpus entry, same order. Stdlib-only (`json`), same
# posture as the rest of Cambium's Ruby surface.
require 'json'
require_relative '../../../../ruby/cambium/schema_export'

corpus = JSON.parse($stdin.read)

results = corpus.map do |entry|
  {
    'verdict' => Cambium::SchemaExport.classify(entry['content'], entry['name']),
    'exports' => Cambium::SchemaExport.list_exports(entry['content']),
  }
end

puts JSON.generate(results)
