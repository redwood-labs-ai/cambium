#!/usr/bin/env node
/**
 * ci-review-input — builds the `--arg` JSON object for the two-input
 * `cambium_ci_review.pipeline.rb` pipeline (#233 / #235).
 *
 * #233's fix (DEC-004/005) adds a second declared `input :surfaces` slot
 * to `CambiumCiReview` alongside the existing `input :diff` — a
 * deterministic, path-derived floor for `touched_surfaces` that the
 * upstream LLM analyzer's own classification can add to but never
 * subtract from. Declaring a second `input` slot makes the pipeline
 * MULTI-SLOT, which #226 enforces fail-closed: `--arg` must become a
 * JSON object supplying every declared slot, not the raw diff text the
 * pipeline accepted before. This script is the one place that builds
 * that object, so the workflow YAML doesn't hand-roll JSON construction
 * around a multi-megabyte diff string.
 *
 * The surface classification itself lives in ONE place —
 * `classifyTouchedSurfaces` in `packages/cambium/src/contracts.ts`,
 * executable form of the comments beside `CAMBIUM_SURFACE` — imported
 * here rather than reimplemented (DEC-006: a second copy in YAML/bash is
 * the #210 failure mode reproduced on a fresh surface).
 *
 * Usage:
 *   git diff --name-only -z <base>...HEAD > /tmp/pr-changed-files.txt
 *   node scripts/ci-review-input.mjs /tmp/pr.diff \
 *     < /tmp/pr-changed-files.txt > /tmp/pipeline-input.json
 *
 * The `-z` (NUL-terminated) form is load-bearing, not cosmetic (AUD-001):
 * plain `git diff --name-only` C-quotes any path containing a byte
 * outside 0x20-0x7e (plus `"` and `\`) — e.g. an em-dash in a docs
 * filename becomes `"docs/... \342\200\224 ...md"`, complete with a
 * literal leading `"` that breaks every `startsWith('docs/')`-shaped
 * rule in `classifyTouchedSurfaces`. `-z` emits paths unquoted,
 * NUL-separated, so this script splits on NUL rather than newline.
 * `core.quotePath=false` was considered and rejected: it still quotes
 * paths containing `"`, `\`, or a newline, narrowing the hole instead
 * of closing it.
 *
 * Reads the changed-file list from stdin (NUL-separated repo-root-
 * relative paths, blank entries ignored — including the empty trailing
 * element every NUL-terminated stream ends with) and the diff text from
 * the file path given as the sole argument. Writes
 * `{"diff": "<diff text>", "surfaces": [...]}` to stdout — no trailing
 * newline is required by any consumer, but one is emitted for a clean
 * terminal/log tail.
 *
 * `tsx/esm/api`'s register() is the same mechanism `cli/cambium.mjs`
 * uses to import `contracts.ts` (a `.ts` file) under plain `node` — see
 * RED-306. `tsx` is a pinned root dependency; no new dep needed.
 *
 * AUD-006 (round 3 audit): the whole body runs inside `main()`, called
 * at the bottom through a `.catch()` that prints `ci-review-input: …`
 * and exits 1 on ANY thrown error — a failed `readFileSync`, a bad
 * `import()`, anything. This is the script being honest about its own
 * failures rather than resting on the Forgejo runner's default `bash -e`
 * to notice a bare Node stack trace; the workflow step that invokes this
 * script no longer ends on an unconditional `echo` either, for the same
 * reason (see `.forgejo/workflows/ci-review.yml`).
 *
 * AUD-008 (round 3 audit): `contracts.ts` resolves from THIS FILE'S OWN
 * location (`import.meta.url`), not `process.cwd()` — correct regardless
 * of which directory the workflow (or a developer) invokes this script
 * from. Cambium spent the day this landed fixing exactly this class of
 * bug elsewhere (#219); this script is one of the things the CI job
 * actually runs, so it doesn't get to be the next one.
 */
import { register } from 'tsx/esm/api';
register();

import { readFileSync } from 'node:fs';

async function main() {
  const diffPath = process.argv[2];
  if (!diffPath) {
    console.error('Usage: node scripts/ci-review-input.mjs <diff-file> < changed-files.txt');
    process.exit(2);
  }

  const diff = readFileSync(diffPath, 'utf8');

  // AUD-F2 (round 2 audit): a non-empty stdin with no NUL byte is not the
  // -z format this script requires -- it is what plain `git diff
  // --name-only` (no -z) produces, and silently mis-parsing it as one giant
  // pseudo-path collapses every surface but (sometimes) the first, exactly
  // the docs-goes-missing failure AUD-001 fixed. `git diff --name-only -z`
  // always NUL-*terminates* every path, so even a single-file diff's
  // output contains one NUL; the only legitimate zero-NUL input is a
  // genuinely empty diff (zero bytes), which must keep classifying as
  // `surfaces: []`. Fail loudly on anything else rather than guess.
  const rawChangedFiles = readFileSync(0, 'utf8');
  if (rawChangedFiles.length > 0 && !rawChangedFiles.includes('\0')) {
    console.error(
      'ci-review-input: stdin is not NUL-separated. Produce it with ' +
        '`git diff --name-only -z <base>...HEAD` -- plain `--name-only` ' +
        '(no -z) C-quotes non-ASCII paths and breaks surface classification ' +
        '(AUD-001).',
    );
    process.exit(2);
  }
  const changedPaths = rawChangedFiles
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean);

  // AUD-008: resolved from this script's own file location, not cwd.
  const contractsUrl = new URL('../packages/cambium/src/contracts.ts', import.meta.url);
  const { classifyTouchedSurfaces } = await import(contractsUrl.href);

  const surfaces = classifyTouchedSurfaces(changedPaths);
  process.stdout.write(JSON.stringify({ diff, surfaces }) + '\n');
}

main().catch((err) => {
  // AUD-006: any failure not already handled above (a bad `import()`, an
  // unreadable diff file, anything unanticipated) is still OUR failure to
  // report clearly, not a bare Node stack trace for whoever reads the CI
  // log next.
  console.error(`ci-review-input: ${err?.message ?? err}`);
  process.exit(1);
});
