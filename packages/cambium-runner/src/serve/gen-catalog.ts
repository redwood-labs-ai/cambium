/**
 * RED-360 phase 1: load the catalog of gens a `cambium serve` instance
 * will dispatch.
 *
 * At server boot we read `Genfile.toml [exports.gens]` and validate the
 * shape — every declared gen file exists, every key is a well-formed
 * export name, every path resolves inside the workspace. This catches
 * Genfile errors before the server starts accepting requests.
 *
 * Deviation from the RFC (worth flagging): the RFC says "compile + cache
 * IR for each entry at boot." Compile.rb requires a `--method` argument,
 * and Cambium GenModels can declare multiple public methods. Without a
 * Ruby-side `--list-methods` mode (out of scope for this slice), the
 * boot loader can't enumerate every (gen, method) pair to pre-compile.
 *
 * The pragmatic v1 split:
 *   - Boot:    parse Genfile, validate shape, validate paths exist on
 *              disk. NO Ruby compilation. Server is ready quickly.
 *   - Per-call: serve.ts compiles each (gen, method) on first request
 *               and caches by composite key. Compile cost (~50–100 ms)
 *               is paid once per pair, then amortized across all later
 *               calls — meaningfully cheaper than the per-request Node
 *               cold-start that drove this work in the first place.
 *
 * Pre-compile-at-boot can be added later by introducing a Ruby
 * `--list-methods` mode and walking (gen × methods) at boot. The cache
 * shape stays the same, so it's a transparent upgrade.
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
  /** Export name as declared in `[exports.gens]` (e.g., "ResumeParser"). */
  name: string;
  /** Absolute path to the `.cmb.rb` gen file. */
  genFilePath: string;
}

export interface GenCatalog {
  /** Absolute path to the directory containing Genfile.toml. */
  workspaceDir: string;
  /** Absolute path to Genfile.toml itself (for error messages). */
  genfilePath: string;
  /** Catalog entries keyed by export name. Keys preserve declared casing. */
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

  const gens = parsed?.exports?.gens;
  if (gens === undefined) {
    throw new Error(
      `cambium serve: ${genfilePath} has no [exports.gens] section. ` +
        `Declare each gen as <ExportName> = "<relative path to .cmb.rb>".`,
    );
  }
  if (typeof gens !== 'object' || Array.isArray(gens) || gens === null) {
    throw new Error(
      `cambium serve: ${genfilePath} [exports.gens] must be a TOML table ` +
        `(got ${Array.isArray(gens) ? 'array' : typeof gens}).`,
    );
  }

  const keys = Object.keys(gens);
  if (keys.length === 0) {
    throw new Error(
      `cambium serve: ${genfilePath} [exports.gens] is empty — nothing to serve. ` +
        `Declare at least one gen.`,
    );
  }

  const entries = new Map<string, GenCatalogEntry>();
  for (const name of keys) {
    if (!GEN_NAME_RE.test(name)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens] key "${name}" is not a valid ` +
          `export name. Names must match /^[A-Z][A-Za-z0-9_]*$/ (PascalCase, optional underscores).`,
      );
    }
    const raw = (gens as Record<string, unknown>)[name];
    if (typeof raw !== 'string') {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens].${name} must be a string path ` +
          `(got ${typeof raw}).`,
      );
    }
    if (raw.length === 0) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens].${name} is an empty string.`,
      );
    }
    if (isAbsolute(raw)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens].${name} = "${raw}" must be ` +
          `relative to the workspace directory (no absolute paths).`,
      );
    }
    const abs = resolve(absWorkspace, raw);
    const rel = relative(absWorkspace, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens].${name} = "${raw}" resolves ` +
          `outside the workspace directory.`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.gens].${name} = "${raw}" — file ` +
          `does not exist at ${abs}.`,
      );
    }
    entries.set(name, { name, genFilePath: abs });
  }

  return { workspaceDir: absWorkspace, genfilePath, entries };
}
