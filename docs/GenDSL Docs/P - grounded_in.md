# Primitive: grounded_in

**Doc ID:** gen-dsl/primitive/grounded-in

## Purpose
Enforce that outputs are grounded in a source document with verifiable citations. When grounding is active, the model must include verbatim quotes from the source, and the runtime verifies them.

## Semantics (normative)
- **Strict pre-flight contract**: when `grounded_in :source` is declared, `ir.context[source]` MUST resolve to non-empty content before any LLM dispatch. The runner enforces this before the first `Generate` step; missing or empty content fails the run immediately with a `GroundingMissing` trace step. **Mock-mode (`CAMBIUM_ALLOW_MOCK=1`) is exempt** so framework-plumbing tests that chain mock outputs through sub-gens still pass.
- When `require_citations: true`, the runner MUST verify all citation quotes against the source document.
- **A repair that deletes provenance MUST fail the run (RED-175).** If the post-repair output carries
  fewer citations (or fewer grounded values) than the output repair was handed, `GroundingCheckAfterRepair`
  / `GroundingFieldValueCheckAfterRepair` reports `ok: false` with `deleted_by_repair: true` and the run
  fails as `validation`. An uncited output is not a grounded output.
- Citation verification is fuzzy (case-insensitive, whitespace-normalized) but requires substring match.
- Fabricated citations (quotes not found in the source) are flagged as errors and fed into the repair loop — which is handed the source it is being told to quote from (RED-175).
- Missing citations (items without any citations) are flagged as errors.
- The runtime auto-registers the `citations` corrector — the author does not need to also declare `corrects :citations`.
- Grounding rules are injected into the system prompt, instructing the model to use exact verbatim quotes.
- **Source name must match `/^[a-z][a-z0-9_]*$/` (RED-283).** `ruby/cambium/runtime.rb#grounded_in` raises `ArgumentError` on any source symbol that doesn't match — joining the regex-guard list that already covers pack names (RED-214), pool names (RED-215), memory keys + `CAMBIUM_SESSION_ID` (RED-215 phase 3), scaffolded tool names (RED-216), and app-corrector basenames (RED-275). The source flows into `ir.context[<source>]` (RED-276) and into the prompt's DOCUMENT: section; rejecting oddly-shaped keys at compile time prevents brittle IRs (`__proto__`, `"has space"`, `CamelCase`).

## Example
```ruby
class Analyst < GenModel
  returns AnalysisReport
  grounded_in :document, require_citations: true

  def analyze(document)
    generate "analyze this document" do
      with context: document
      returns AnalysisReport
    end
  end
end
```

The symbol passed to `grounded_in` is the canonical name of the source. The compiler uses it as the key under `ir.context` — so a gen with `grounded_in :linear_issue` emits `"context": { "linear_issue": "..." }` rather than the default `"document"` key (RED-276). All runtime code paths (prompt assembly, citation verification, review, memory read) resolve the source via `ir.policies.grounding.source`, falling back to `context.document` when no grounding is declared. A gen without `grounded_in` keeps the default `document` shape for back-compat.

## What happens at runtime
0. **Pre-flight (RED-374-381 follow-up)**: runner reads `ir.context[source]` (or `groundingTextByKey[source]` for extracted PDF text). If empty/missing → emit `GroundingMissing` trace step and return `ok: false` BEFORE step 1 fires. Hint in the error points the operator at `--arg` (standalone runs) or the pipeline `with:` binding (pipeline runs). Mock-mode is exempt.
1. System prompt includes GROUNDING RULES telling the model to produce verbatim quotes
2. Model generates output with citations
3. Regular correctors run (math, dates, etc.)
4. **GroundingCheck**: citations corrector verifies every quote exists in the source document
5. If fabricated quotes found → repair loop with specific error messages, **and the source document** (RED-175, see § What repair is given)
6. Re-verify: the `citations` corrector runs again on the repaired output (`GroundingCheckAfterRepair`). `ok: false` when a quote is still unverifiable — **or** when the repair deleted citations, which also fails the run (RED-175)
7. If all quotes verified and none deleted → grounding passes

## What repair is given (RED-175)

When `GroundingCheck` fails, the repair pass receives the same four things the checker saw: the
task, the document (`DOCUMENT:` + any non-primary context sections), the previous output, and the
complaints. It also gets GROUNDING RULES — the same block `buildGenSystem` put in the generate call —
so "copy the quote exactly" is stated in both passes, and the repair rules add "never delete a
citation or a grounded value; correct it instead".

Before this, repair was handed the complaint and not the material. Told that a quote is not in a
source it cannot read, the model's only lawful move was to blank the field — so the gen kept
reporting `ok: true` and stopped being grounded.

The re-verify no longer passes vacuously. `GroundingCheckAfterRepair` counts the citations on the
output repair was handed (`citations_before`) and on the output it produced (`citations_after`); fewer
after is a deletion, so the step reports `ok: false` with `deleted_by_repair: true` and the run fails
as `validation` instead of shipping an uncited answer. The same pair of numbers, named
`values_before` / `values_after`, guards `verify: :field_values`. What the document does is remove the
*reason* to delete; what the guard does is make deletion visible at the API boundary if the model
deletes anyway. See [[C - Repair Loop]] § The deletion guard.

## PDF sources

**What the model sees and what the verifier checks against are allowed to differ** — PDFs were the first case of that, and text `format:`s (below) are the second. When the source resolves to a `base64_pdf` envelope under `ir.context`, the runner extracts the PDF's text layer via `pdfjs-dist` and uses that as the verification corpus. The model still sees the PDF as a native document block (preserves Claude's PDF reasoning); verification reads extracted text on Cambium's side.

**Scanned / image-only PDFs**: text-layer extraction yields nothing and the run fails fast before generation, with a pointer to the workaround. Cambium does not ship OCR — it's out of scope. Pattern: OCR upstream, pass the extracted text under the `grounded_in` key, and optionally pass the PDF under a different key for visual context:

```ruby
grounded_in :report
# ir.context = {
#   report: "<OCR-extracted text>",          # verifier reads this
#   report_pdf: { kind: 'base64_pdf', ... }  # optional: model also sees the PDF
# }
```

That keeps citation verification deterministic while still giving the model visual context if it helps.

## IR output
```json
"policies": {
  "grounding": {
    "source": "linear_issue",
    "require_citations": true
  }
},
"context": {
  "linear_issue": "..."
}
```

Note the `context` key matches the grounding `source` — the two stay aligned by the compiler. Gens without `grounded_in` emit `"context": { "document": "..." }`.

## Failure modes
- **Source missing or empty**: `ir.context[source]` resolves to nothing → `GroundingMissing` trace step, run exits `ok: false` before any LLM dispatch. The `errorMessage` quotes what was found and points at either `--arg` (standalone runs) or the pipeline `with:` binding (pipeline runs) as the fix.
- **Mock-mode exemption**: `CAMBIUM_ALLOW_MOCK=1` skips the pre-flight check. Used by framework-plumbing tests where upstream steps produce empty mock outputs that downstream sub-gens (declaring `grounded_in :document`) would otherwise refuse.
- **Fabricated quote**: model invents text not in the document → error, triggers repair.
- **Missing citations**: item has no citations → error, triggers repair.

## Loading from disk: the `from:` kwarg (RED-383)

```ruby
grounded_in :report, from: "examples/report.pdf"
grounded_in :doc,    from: "/abs/path/to/document.txt"
```

When `from:` is set, the compiler reads the file at compile time and stamps the resolved value into `ir.context[<source>]`. Path resolution: relative paths anchor to the gen file's directory (not cwd) so a gen compiles the same way regardless of where the operator runs it from; absolute paths pass through unchanged.

Content-type by extension:

| Extension | Becomes |
| --- | --- |
| `.pdf` | `{ kind: 'base64_pdf', data, media_type: 'application/pdf' }` envelope (consumed by the same RED-323 path Anthropic native PDF blocks + the extracted-text fallback for other providers already use) |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | `{ kind: 'base64_image', data, media_type }` envelope |
| Everything else | Plain string (file read as text) |

**CLI `--arg` still wins at runtime.** `from:` is a default — it provides the value when no runtime input is supplied. `cambium run gen.cmb.rb --method analyze` (no `--arg`) uses the from:-baked value; `--arg fixture.txt` overrides. Pipelines that `bind(:input).field` or `bind(:prior_step)` into the sub-gen's context override too. The bake-in is a sensible-default mechanism for "ground in this PDF on disk" without forcing the operator to thread the file through `--arg` every invocation.

**Errors fire at compile time.** File-not-found, "exists but is not a regular file", and non-string `from:` values all raise `CompileError` from `compile.rb` with the resolved path + a pointer to the relative-vs-absolute rule.

### What's NOT in v1

* URL fetching (`from: "https://..."`) — needs the network-allowlist plumbing wire-up; deferred to RED-383 v2
* Magic-byte content-type sniffing for files without a recognized extension — deferred to RED-383 v2 (today, unmarked binaries land as text + fail downstream)
* Inline arrays of sources — `grounded_in :doc, from: ["a.pdf", "b.pdf"]` not supported. One gen call grounds in one source; concatenate upstream. Per-document citation attribution changes the `citations[]` shape, so multi-source grounding is a separate, low-priority follow-up
* `format:` derivers for CSV and HTML — P1, same shape as the Markdown and JSON derivers below

## Text sources: the `format:` kwarg

A grounding source that is Markdown or JSON has two readings: the bytes on disk, and the text a reader actually sees. A model quoting `Revenue grew 12% in Q3` from `Revenue grew **12%** in Q3` is quoting correctly — but the matcher normalizes case, whitespace and a little punctuation and then substring-matches, so the asterisks stay in the haystack and the correct quote is reported as fabricated. That failure then fires the repair loop against an output that was right.

`format:` tells the verifier what shape the source is, so it can check a **derived plain-text view** of the document in addition to the raw text:

```ruby
grounded_in :notes,   from: "notes.md",  require_citations: true   # format inferred: markdown
grounded_in :payload, format: :json, verify: :field_values         # explicit — serve / pipeline input
grounded_in :journal, from: "journal.md", format: :text            # opt out of inference
```

Values: `:markdown`, `:json`, `:text`. Anything else raises `ArgumentError` at compile time.

**The model's prompt does not change.** The derived view is verifier-only: it never enters `groundingTextByKey`, so prompt assembly, the RED-175 semantic repair prompts, `enrich`, and compound review all keep seeing the source exactly as before — link URLs, code fences, table structure intact — and no prompt-cache prefix moves because a gen adopted a `format:`.

### Inference from the source path

`format:` is usually inferred, not written. The compiler reads the extension of **whichever path supplied the context value**:

| Precedence | Source of the path | Notes |
| --- | --- | --- |
| 1 | explicit `format:` | always wins; `format: :text` opts out of inference |
| 2 | CLI `--arg <path>` | when a real path was passed and the file is non-empty |
| 3 | `from: "<path>"` | when the baked-in value is what lands in context |

| Extension | Inferred |
| --- | --- |
| `.md`, `.markdown` | `markdown` |
| `.json` | `json` |
| anything else | *no key* — plain text is the default and needs no deriver |

Piped stdin (`--arg -`) has no path, so nothing is inferred. **Serve and pipeline callers have no path either** — `/v1/run` input and a pipeline `with:` / `bind()` binding supply a value, not a filename — so those gens must declare `format:` explicitly. Note the corollary: a `from:` bake-in *infers* a format into the compiled IR, and that inferred format still applies when a serve request or a pipeline binding replaces the document at run time — the IR does not know the document changed. If a gen bakes in `notes.md` but is normally fed something else, declare `format: :text` to opt out (or `format:` whatever the runtime document actually is).

When nothing is set, no `format` key is emitted at all: a gen that doesn't use this compiles to exactly the bytes it did before.

### What each deriver produces

Both are pure functions, hand-rolled over Node builtins (no Markdown or JSON dependency), and neither needs to be exhaustive — the raw text is still checked first, so a deriver can only ever *add* matches.

- **`markdown`** — the text a reader sees. Emphasis and inline code unwrapped to their content; struck-through text (`~~x~~`) dropped as retracted content; links and images reduced to their text/alt; reference-link definitions, horizontal rules and table separator rows dropped; table pipes become spaces; heading, list, task-box and blockquote markers stripped; inline HTML tags removed and `&amp;`-style entities decoded; backslash escapes resolved. Fenced code blocks are emitted **verbatim**, so `x = a * b` is never mistaken for emphasis, and underscore italics only unwrap when the delimiters bound whole words, so `max_tokens` survives. Lines longer than 20,000 characters are left untransformed — real prose lines are far shorter, a single enormous "line" is the adversarial shape, and raw matching still applies to it.
- **`json`** — a decoded, pretty haystack. The source is parsed (or taken as-is when the context value is already structured, e.g. a pipeline `bind()`), then re-rendered with 2-space indent, one array element per line, and **string contents unescaped between quotes**: `\n` becomes a newline, `\"` a quote, `\u00fc` a `ü`. Keys keep their `"key": value` adjacency, so a fragment quoted from a compact source matches a pretty one and vice versa. The output is deliberately not valid JSON — it is a haystack, not a document. Unparseable JSON derives nothing and verification proceeds against the raw text; it is never a run failure.
- **`text`** — no derivation. This is the default behavior, named explicitly.

### Matching and reporting

Verification is **any-of, raw first**: the citation (or field value) is looked for in the source document as-is, and only then in the derived view. Each entry in `citationResult.passed[]` / `fieldValuesResult.passed[]` carries `matched_via: "document" | "derived"`, so `"derived"` means precisely *this passes only because of the format-aware view* — the line to read when tuning a deriver. Failure reasons are unchanged, and a model that quotes the literal markup passes exactly as it always did.

The four grounding trace steps (`GroundingCheck`, `GroundingCheckAfterRepair`, `GroundingFieldValueCheck`, `GroundingFieldValueCheckAfterRepair`) carry `meta.format` and `meta.derived` when a format is set, and neither key when one isn't. No new step type. See [[C - Trace (observability)]].

### `format:` IR output

```json
"policies": {
  "grounding": {
    "source": "notes",
    "require_citations": true,
    "from": "../../examples/fixtures/release_notes.md",
    "format": "markdown"
  }
}
```

### Errors

- A value outside the enum raises `ArgumentError`: `grounded_in :notes format: must be nil or one of :markdown, :json, :text, got :yaml`.
- `format:` describes text, so combining it with a `from:` that resolves to a `base64_pdf` / `base64_image` envelope raises `CompileError`: *"…applies to text sources, but from: "report.pdf" resolved to a base64_pdf envelope. Drop format: or point from: at a text file."* PDFs already get a verifier-side view of their own (§ PDF sources).

## Value-level verification: the `verify:` kwarg (RED-392)

By default `grounded_in` verifies **citations** — "did the model quote text that actually exists in the source?". `verify: :field_values` adds a second, complementary mode that verifies **extracted values** — "are the structured values the model put in the output actually present in the source?".

```ruby
grounded_in :invoice, verify: :field_values
grounded_in :receipt, from: "./receipt.pdf", verify: :field_values
```

This is for **structured-extraction** gens (invoice parsers, contract extraction, document Q&A) — anything that pulls typed fields out of a source. Instead of each gen rolling its own "do these fields match the source" check, the framework cross-checks them.

**How it works.** After generation (and after the citations check, if `require_citations` is also set), the runner runs the built-in `field_values` corrector against the output:
- It walks the output tree and, for each **leaf value** (string or number), checks the value appears in the grounding document via normalized substring match (case-insensitive, whitespace-collapsed, punctuation-tolerant for numeric formatting like `1,234` vs `1234`).
- **Skipped:** booleans, `null`/`undefined`, and any `citations` field (already covered by the citations corrector).
- On a mismatch it emits a `GroundingFieldValueCheck` step (`ok: false`) and feeds the failing fields into one repair attempt (`ValidateAfterGroundingValues` re-validates the repaired output's schema). See [[C - Trace (observability)]].

**Limitations (v1, deterministic substring matcher).** This is an exact-presence check, not a semantic judge:
- **Derived / normalized / enum values may false-fail.** A value the model correctly normalized (`vendor_name: "Acme Corporation"` when the doc says "ACME CORP.", or a currency code, or a computed total) isn't verbatim in the doc and will be flagged → a wasted (and possibly output-degrading) repair. If your schema has such fields, prefer not enabling `verify:` on the whole output yet.
- **Very short values are skipped.** Values with fewer than 3 characters after trimming surrounding whitespace (`"5"`, `"US"`, `"  x"`) are skipped automatically — they appear as incidental substrings in nearly any document and would produce near-100% false-positives.
- Use `fields:` to scope to specific output fields when only a subset is safe to cross-check (see below). A semantic/LLM-judge strategy (`verify: :semantic_similarity`) is the natural follow-up; deferred post-0.7.0.

An empty grounding document is caught earlier by the `GroundingMissing` pre-flight (it fires for any `grounded_in` source), so `verify:` never runs against an empty doc on a real run.

### `fields:` — scope the check to specific top-level keys

When only a subset of output fields is safe to cross-check (e.g., some fields are derived or normalized and would false-fail), use `fields:` to name them explicitly:

```ruby
grounded_in :invoice, verify: :field_values, fields: [:vendor, :total]
```

This skips all top-level output keys not in the list (they appear in the trace as `skipped` with reason `"not in fields allowlist"`). Nested keys inside an allowed top-level key are always checked.

- `fields:` accepts an Array of Symbols. A non-symbol element, an empty array, or using `fields:` without `verify: :field_values` raises `ArgumentError` at compile time.
- Top-level names only. Dot-notation paths (`fields: ["billing.vendor"]`) are not supported in v1.

### `verify:` and `fields:` IR output

```json
"policies": {
  "grounding": {
    "source": "invoice",
    "require_citations": false,
    "verify": "field_values",
    "fields": ["vendor", "total"]
  }
}
```

When `fields:` is omitted, the `fields` key is absent from the IR and all leaves are checked.

Invalid strategies are rejected at compile time: `grounded_in :doc, verify: :bogus` raises a `CompileError` ("verify: must be nil or one of :field_values").

## Future: richer source types

URL fetching and magic-byte sniffing complete the design in [RED-383 v2](https://linear.app/redwood-labs/issue/RED-383). The v1 file-paths-only cut covers the canonical "ground in this PDF on disk" friction without dragging in the SSRF-guard / allowlist work URLs need.

## See also
- [[D - Grounding Sources]]
- [[C - Repair Loop]]
- [[C - Schema Description (auto-generated)]]
- [[P - returns]]
