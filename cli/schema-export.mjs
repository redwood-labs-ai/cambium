// Canonical definition of "is this schema exported?" (DEC-001, issues
// #210/#212). This is the ONE JS-side implementation; `ruby/cambium/
// schema_export.rb` is a deliberate, pattern-for-pattern mirror on the
// Ruby side. Agreement between the two is enforced by the parity test
// over `packages/cambium/tests/fixtures/schema-export-corpus.json`
// (see `schema_export_parity.test.ts`) — never edit one side without
// the other; the corpus test will go red.
//
// Lineage: DEC-158-007 (issue #158, AUD-158-01) established the
// fail-safe direction for the scaffolder — a false "exists" costs the
// user one export added by hand; a false "absent" corrupts their file
// by appending a colliding declaration. #206 ported the check to
// engine mode via a shared three-pattern helper. The audit that
// followed (#206 round 1) found the compiler and lint used a much
// narrower single-pattern check, disagreeing with the scaffolder for
// idioms the scaffolder had since learned to recognize (#210), and that
// the scaffolder's own three patterns still missed several `export
// <keyword> <Name>` forms and could not see `export * from` re-exports
// at all (#212).
//
// This module answers "is `<name>` exported from this file?" as a
// TRI-STATE (DEC-002), not a boolean, because the five call sites want
// opposite fail-safe directions:
//   - 'exported'   — a pattern positively matched.
//   - 'absent'     — no pattern matched, and the file's export set IS
//                     knowable (no `export *`).
//   - 'unknowable' — the file re-exports via `export * [as ns] from
//                     '...'`; its export set cannot be determined by
//                     regex at all.
// A consumer whose destructive act is APPENDING (the scaffolder) must
// treat 'unknowable' the same as 'exported' (skip — never risk a
// silent shadow, AUD-206-03). A consumer whose destructive act is
// RAISING/FAILING (the compiler, lint) must treat 'unknowable' the
// same as "proceed" — enforcement falls through to the layers that
// resolve the real module (the runner's own-property lookup, serve's
// boot preflight). Only 'absent' still raises/fails — the RED-210 typo
// class stays caught.

// Pattern C (DEC-004): a top-level `export *` (bare re-export or
// `export * as ns from '...'`) means this file's export set cannot be
// proven by regex — checked FIRST, before the name-specific patterns.
const STAR_EXPORT_RE = /^\s*export\s*\*/m;

// AUD-F1: JS's `^` (with `/m`, used by STAR_EXPORT_RE and
// declarationPattern below) treats U+2028, U+2029, and a bare `\r` as
// line terminators, in addition to `\n` — Ruby's `^` treats only `\n`.
// Normalizing every alternate line terminator to `\n` up front collapses
// the "which bytes start a line" question to one explicit step both
// languages agree on, rather than leaning on each regex engine's own
// (divergent) LineTerminator definition.
function normalizeLineEndings(content) {
  return content.replace(/\r\n|\r|\u2028|\u2029/g, '\n');
}

// Escape at the boundary (RED-206, AUD-206-05): `name` is interpolated
// into regex literals below. No-op for every currently-legal scaffolder
// name (`validateName`'s `/^[A-Za-z][A-Za-z0-9_]*$/`), but this module
// has more callers than the scaffolder now (lint, the compiler's Ruby
// mirror), so the boundary escape stays a hard rule, not a precondition
// callers are trusted to uphold.
function escapeForRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pattern A (DEC-004): `export { … Name … }` — an export list naming
// `name` anywhere inside the braces, including as the local half of an
// `X as Y` alias. Deliberately does NOT match `export type { X }` — the
// brace must follow `export` with only whitespace between, and `export
// type {` has the `type` keyword in the way (DEC-004's documented
// approximation; very-low-plausibility idiom, recorded `absent` in the
// corpus).
function exportListPattern(escapedName) {
  return new RegExp(`export\\s*\\{[^}]*\\b${escapedName}\\b[^}]*\\}`);
}

// Pattern B (DEC-004, #212-generalized): any top-level declaration of
// `name`, with an optional `export` (optionally `export default`) and
// optional `async` prefix. Subsumes the legacy `export const`-only
// pattern; carrying the `export` prefix as OPTIONAL is deliberate — a
// bare top-level `const Name = …` is treated as "already present" too
// (DEC-158-007's original fail-safe stance: don't risk a second,
// colliding declaration even when the existing one isn't exported).
function declarationPattern(escapedName) {
  return new RegExp(
    `^\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?` +
      `(?:const|let|var|class|function|type|interface|enum|namespace)\\s+${escapedName}\\b`,
    'm',
  );
}

// Generic (non-name-specific) forms of patterns A/B for discovery
// (DEC-005) — same two patterns, but capturing whatever identifier they
// find rather than testing for one we already know.
const DECLARATION_NAME_RE =
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:const|let|var|class|function|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;

/**
 * classify(content, name) → 'exported' | 'absent' | 'unknowable'
 *
 * The tri-state answer to "is `name` exported from this file?" See the
 * module doc comment above for the fail-safe semantics each consumer
 * must apply.
 */
export function classify(content, name) {
  content = normalizeLineEndings(content);
  if (STAR_EXPORT_RE.test(content)) return 'unknowable';
  const n = escapeForRegExp(name);
  if (exportListPattern(n).test(content) || declarationPattern(n).test(content)) {
    return 'exported';
  }
  return 'absent';
}

/**
 * isExportedOrUnknowable(content, name) → boolean
 *
 * The convenience boolean (DEC-002) for consumers whose destructive act
 * is appending — `exported` and `unknowable` both mean "don't touch
 * this file for this name."
 */
export function isExportedOrUnknowable(content, name) {
  const verdict = classify(content, name);
  return verdict === 'exported' || verdict === 'unknowable';
}

/**
 * listExports(content) → string[]
 *
 * Export DISCOVERY (DEC-005) — best-effort DX, not enforcement. Returns
 * every name pattern A or pattern B can see, in the order encountered
 * (declarations first, then export-list entries). `X as Y` aliasing
 * yields `Y`. A file that is `unknowable` (contains `export *`) still
 * returns whatever names ARE visible — the star re-export just means
 * the list may be incomplete, not that it's empty.
 */
export function listExports(content) {
  content = normalizeLineEndings(content);
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };

  for (const m of content.matchAll(DECLARATION_NAME_RE)) {
    add(m[1]);
  }
  for (const m of content.matchAll(EXPORT_LIST_RE)) {
    for (const rawItem of m[1].split(',')) {
      const item = rawItem.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      add(aliasMatch ? aliasMatch[2] : item);
    }
  }
  return names;
}
