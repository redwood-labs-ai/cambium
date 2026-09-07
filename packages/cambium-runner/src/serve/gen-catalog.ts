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
 *
 * #195 precompiled mode: `{ precompiled: true }` or `{ irDir }` resolves
 * each `[exports.gens]` entry to a `.ir.json` artifact instead of the
 * `.cmb.rb` source — no Ruby spawn either way (`serve.ts`'s boot loop
 * reads the artifact off disk rather than calling `compileBare`). The
 * declared `.cmb.rb` need not exist on disk in this mode (shipped
 * workspaces carry artifacts only); the artifact path is always built
 * from `basename()` of the already-validated `.cmb.rb` value, so no new
 * symbol-into-path join is introduced. `[exports.pipelines]` is refused
 * outright in precompiled mode — a Pipeline IR still needs Ruby at run
 * time per sub-gen (DEC-001, `ir-artifact.ts`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { findGenfileDir } from '../genfile.js';

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
  /** #195: absolute path to the precompiled `.ir.json` artifact. Set only
   *  when `loadGenCatalog` was called with `{ precompiled: true }` or
   *  `{ irDir }`; absent (not `undefined`-but-present) otherwise. `serve.ts`'s
   *  boot loop reads this instead of calling `compileBare` when set. */
  irPath?: string;
  /** #195 A-003 (AUD-001): the gen's OWN workspace — the nearest
   *  `Genfile.toml` above its declared source path, falling back to the
   *  serve workspace when none sits between. Set only in precompiled mode.
   *  This is what compile-at-boot resolves by walking up from
   *  `entry.source`; anchoring every gen on `--workspace` instead broke a
   *  root that exports gens from a member package with its own `[types]`. */
  appRoot?: string;
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

export interface LoadGenCatalogOptions {
  /** #195: resolve every `[exports.gens]` entry to its sibling `.ir.json`
   *  artifact (what `cambium compile --write` / engine mode writes) instead
   *  of the `.cmb.rb` source. No Ruby spawn either way. */
  precompiled?: boolean;
  /** #195: resolve every `[exports.gens]` entry to `<irDir>/<basename
   *  without .cmb.rb>.ir.json` (what `cambium compile --out-dir <dir>`
   *  writes) instead of a sibling of the `.cmb.rb` source. Implies
   *  `precompiled`; wins when both are set. */
  irDir?: string;
}

/**
 * Read `Genfile.toml` from `workspaceDir`, parse `[exports.gens]`, and
 * return a validated catalog. Throws with a workspace-aware message on
 * any error — boot should fail fast, not partially load.
 */
export function loadGenCatalog(workspaceDir: string, opts: LoadGenCatalogOptions = {}): GenCatalog {
  const absWorkspace = resolve(workspaceDir);
  const genfilePath = join(absWorkspace, GENFILE_NAME);
  const precompiled = Boolean(opts.precompiled || opts.irDir);
  const absIrDir = opts.irDir ? resolve(opts.irDir) : null;

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

  // #195 DEC-002: pipelines are refused outright in precompiled mode — a
  // Pipeline IR still shells out to Ruby per sub-gen at request time
  // (`ir-artifact.ts`'s `runtimeCompileSites`), so "no Ruby on PATH" would
  // be a per-request surprise instead of a boot-time refusal. Checked
  // before any path validation: precompiled mode never touches the
  // `.pipeline.rb` file, so there's nothing to validate a path against.
  if (precompiled && pipelines !== undefined) {
    if (typeof pipelines !== 'object' || Array.isArray(pipelines) || pipelines === null) {
      throw new Error(
        `cambium serve: ${genfilePath} [exports.pipelines] must be a TOML table ` +
          `(got ${Array.isArray(pipelines) ? 'array' : typeof pipelines}).`,
      );
    }
    const names = Object.keys(pipelines as Record<string, unknown>);
    if (names.length > 0) {
      throw new Error(
        `cambium serve: ${genfilePath} declares [exports.pipelines] (${names.join(', ')}) — ` +
          `pipelines need Ruby at run time (pipeline) and cannot be loaded from a precompiled ` +
          `artifact (#195). Remove them from [exports.pipelines], or boot without --precompiled/--ir-dir.`,
      );
    }
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
    { skipExistenceCheck: precompiled },
  );
  if (!precompiled) {
    validateAndAddSection(
      'pipelines',
      pipelines,
      'pipeline',
      'pipeline.rb',
      genfilePath,
      absWorkspace,
      entries,
      {},
    );
  }

  if (entries.size === 0) {
    throw new Error(
      `cambium serve: ${genfilePath} declares no entries in [exports.gens] or ` +
        `[exports.pipelines] — nothing to serve.`,
    );
  }

  // #195 DEC-002: resolve each gen entry to its precompiled artifact.
  // `--ir-dir` wins over `--precompiled` when both are set (flat-by-
  // basename); otherwise the artifact is the sibling `.ir.json` next to
  // the `.cmb.rb` (what `cambium compile --write` / engine mode write).
  // Both paths are built from `basename()` of the already-validated
  // `.cmb.rb` path — no new symbol-into-path join. Every entry must
  // resolve to an artifact or boot fails, listing every offender in one
  // error (mixed catalogs are not a thing).
  if (precompiled) {
    const missing: string[] = [];
    for (const entry of entries.values()) {
      const irPath = absIrDir
        ? join(absIrDir, irArtifactName(entry.genFilePath))
        : join(dirname(entry.genFilePath), irArtifactName(entry.genFilePath));
      if (!existsSync(irPath)) {
        missing.push(`${entry.name} → ${irPath}`);
      } else {
        entry.irPath = irPath;
        // The declared source path is validated relative-inside-workspace
        // above, so this walk-up is bounded by the workspace root (which
        // always has a Genfile — the catalog came from it).
        entry.appRoot = findGenfileDir(entry.genFilePath) ?? absWorkspace;
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `cambium serve: precompiled artifact(s) not found:\n  ${missing.join('\n  ')}\n` +
          `Run \`cambium compile --write\` (or --out-dir <dir> to match --ir-dir) to produce them.`,
      );
    }
  }

  return { workspaceDir: absWorkspace, genfilePath, entries };
}

/** `<base>.ir.json` for a `.cmb.rb` path — mirrors `cli/compile.mjs`'s
 *  `irOutputName` for the `.cmb.rb` case (pipelines never reach this
 *  function; they're refused outright in precompiled mode above). */
function irArtifactName(cmbRbPath: string): string {
  return `${basename(cmbRbPath, '.cmb.rb')}.ir.json`;
}

function validateAndAddSection(
  sectionName: 'gens' | 'pipelines',
  section: unknown,
  kind: 'gen' | 'pipeline',
  expectedExt: string,
  genfilePath: string,
  absWorkspace: string,
  entries: Map<string, GenCatalogEntry>,
  { skipExistenceCheck = false }: { skipExistenceCheck?: boolean },
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
    // #195: in precompiled mode the declared `.cmb.rb` need not exist on
    // disk — shipped workspaces carry artifacts only. The extension check
    // below still applies: the catalog names gens, not arbitrary files.
    if (!skipExistenceCheck && !existsSync(abs)) {
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
