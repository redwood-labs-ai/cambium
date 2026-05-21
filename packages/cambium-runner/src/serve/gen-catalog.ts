/**
 * RED-360 phase 1: load the catalog of gens a `cambium serve` instance
 * will dispatch.
 *
 * At server boot we read `Genfile.toml [exports.gens]` and validate the
 * shape — every declared gen file exists, every key is a well-formed
 * export name, every path resolves inside the workspace. This catches
 * Genfile errors before the server starts accepting requests.
 *
 * This module does **path-and-shape validation only** — no Ruby
 * compilation. The actual per-gen compile happens in `serve.ts`'s boot
 * loop, which calls `compileBare(entry.genFilePath)` for each catalog
 * entry. `compile.rb`'s bare mode (no `--method`) emits a full
 * `{method → IR}` map per gen in one Ruby invocation, so boot-time
 * pre-compile across all methods is one Ruby spawn per gen rather than
 * one per (gen, method) pair. Boot failure on any gen fails the server
 * startup (no half-loaded state).
 *
 * Path-traversal stance mirrors RED-274 (resolveGenfileContracts):
 * absolute entries rejected, `..` escapes rejected, NUL bytes rejected,
 * file existence checked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

const GENFILE_NAME = 'Genfile.toml';

// Gen export names mirror Ruby class names (PascalCase, optional
// underscores). The export key flows into IR.entry.class lookups and
// into the wire format's `gen` field, so we want the same shape across
// the stack.
const GEN_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;

export interface GenCatalogEntry {
  /** Export name as declared in `[exports.gens]` or `[exports.pipelines]`
   *  (e.g., "ResumeParser", "CiReview"). */
  name: string;
  /** Absolute path to the `.cmb.rb` (gen) or `.pipeline.rb` (pipeline) file. */
  genFilePath: string;
  /** RED-381 Phase F.3: which Genfile section declared this entry. The
   *  serve dispatcher routes 'pipeline' entries to runPipelineFromIr
   *  and 'gen' entries to runGenFromIr. Boot detects the kind from the
   *  Genfile section; the IR's own kind field is the runtime-side
   *  invariant. */
  kind: 'gen' | 'pipeline';
}

export interface GenCatalog {
  /** Absolute path to the directory containing Genfile.toml. */
  workspaceDir: string;
  /** Absolute path to Genfile.toml itself (for error messages). */
  genfilePath: string;
  /** Catalog entries keyed by export name. Keys preserve declared casing.
   *  Names are unique across the union of [exports.gens] and
   *  [exports.pipelines] — duplicates raise at load time. */
  entries: Map<string, GenCatalogEntry>;
}

/**
 * Read `Genfile.toml` from `workspaceDir`, parse `[exports.gens]`, and
 * return a validated catalog. Throws with a workspace-aware message on
 * any error — boot should fail fast, not partially load.
 */
export function loadGenCatalog(workspaceDir: string): GenCatalog {
  const absWorkspace = resolve(workspaceDir);
  const genfilePath = join(absWorkspace, GENFILE_NAME);

  if (!existsSync(genfilePath)) {
    throw new Error(
      `cambium serve: no Genfile.toml at ${genfilePath}. ` +
        `--workspace must point to a Cambium workspace directory.`,
    );
  }

  let parsed: any;
  try {
    parsed = parseToml(readFileSync(genfilePath, 'utf8'));
  } catch (e: any) {
    throw new Error(
      `cambium serve: failed to parse ${genfilePath}: ${e?.message ?? String(e)}`,
    );
  }

  // RED-381 Phase F.3: pipelines declared parallel to gens, in
  // `[exports.pipelines]`. Same validation surface (name regex, path
  // shape, traversal guard, existence check); kind tag on each entry
  // tells the serve dispatcher which runner to use.
  const gens = parsed?.exports?.gens;
  const pipelines = parsed?.exports?.pipelines;
  if (gens === undefined && pipelines === undefined) {
    throw new Error(
      `cambium serve: ${genfilePath} has neither [exports.gens] nor [exports.pipelines]. ` +
        `Declare at least one gen or pipeline to serve.`,
    );
  }

  const entries = new Map<string, GenCatalogEntry>();
  validateAndAddSection(
    'gens',
    gens,
    'gen',
    'cmb.rb',
    genfilePath,
    absWorkspace,
    entries,
  );
  validateAndAddSection(
    'pipelines',
    pipelines,
    'pipeline',
    'pipeline.rb',
    genfilePath,
    absWorkspace,
    entries,
  );

  if (entries.size === 0) {
    throw new Error(
      `cambium serve: ${genfilePath} declares no entries in [exports.gens] or ` +
        `[exports.pipelines] — nothing to serve.`,
    );
  }

  return { workspaceDir: absWorkspace, genfilePath, entries };
}

function validateAndAddSection(
  sectionName: 'gens' | 'pipelines',
  section: unknown,
  kind: 'gen' | 'pipeline',
  expectedExt: string,
  genfilePath: string,
  absWorkspace: string,
  entries: Map<string, GenCatalogEntry>,
): void {
  if (section === undefined) return;
  if (typeof section !== 'object' || Array.isArray(section) || section === null) {
    throw new Error(
      `cambium serve: ${genfilePath} [exports.${sectionName}] must be a TOML table ` +
        `(got ${Array.isArray(section) ? 'array' : typeof section}).`,
    );
  }

  const sectionTable = section as Record<string, unknown>;
  for (const name of Object.keys(sectionTable)) {
    if (!GEN_NAME_RE.test(name)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}] key "${name}" is not a valid ` +
          `export name. Names must match /^[A-Z][A-Za-z0-9_]*$/ (PascalCase, optional underscores).`,
      );
    }
    if (entries.has(name)) {
      const prior = entries.get(name)!;
      throw new Error(
        `cambium serve: ${genfilePath} declares "${name}" in both [exports.${sectionName}] ` +
          `and [exports.${prior.kind === 'gen' ? 'gens' : 'pipelines'}]. Names must be ` +
          `unique across the union of gens and pipelines.`,
      );
    }
    const raw = sectionTable[name];
    if (typeof raw !== 'string') {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} must be a string path ` +
          `(got ${typeof raw}).`,
      );
    }
    if (raw.length === 0) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} is an empty string.`,
      );
    }
    if (isAbsolute(raw)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} = "${raw}" must be ` +
          `relative to the workspace directory (no absolute paths).`,
      );
    }
    const abs = resolve(absWorkspace, raw);
    const rel = relative(absWorkspace, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} = "${raw}" resolves ` +
          `outside the workspace directory.`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} = "${raw}" — file ` +
          `does not exist at ${abs}.`,
      );
    }
    if (!abs.endsWith(`.${expectedExt}`)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.${sectionName}].${name} = "${raw}" must end ` +
          `with .${expectedExt} (got ${raw.split('.').pop() ?? '(no extension)'}).`,
      );
    }
    entries.set(name, { name, genFilePath: abs, kind });
  }
}
