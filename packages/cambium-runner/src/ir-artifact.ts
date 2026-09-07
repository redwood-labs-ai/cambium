// ── IR artifact reader (#195) ───────────────────────────────────────────
//
// One shared validator for "bytes on disk claiming to be compiler
// output" — used by `cambium serve --precompiled` / `--ir-dir` boot and
// `cambium run --ir`. `replay.ts`'s bare `JSON.parse` of a run's own
// `ir.json` is the counter-example this closes for the precompiled
// surfaces: a hand-edited, stale, or wrong-shape artifact should fail
// here with a clear message, not deep inside the runner.
//
// Deliberately NOT a full JSON-Schema validation of the IR — `IR` is an
// opaque, phantom-branded handle (see runner.ts's `IR_BRAND`) and a
// schema would become a second, drifting definition of its shape. This
// checks only the structural minimum a caller needs before trusting the
// bytes: version, entry, steps, context, the
// returnSchema/returnSchemaId xor, and the DEC-001 closed-IR rule (no
// pipeline, `enrich`, or retro-agent memory-write site — each of those
// needs Ruby at run time).

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IR, IRInternal } from './runner.js';
import { findGenfileDir, resolveGenfileContracts } from './genfile.js';
import { findEngineDirFromCwd } from './engine-root.js';

/**
 * Compiler `version` strings this runner will load from an artifact.
 * Bumping `compile.rb`'s emitted `version` requires adding it here —
 * that coupling is the point: this is the one place the runner states
 * what compiler output it accepts off disk.
 */
export const SUPPORTED_IR_VERSIONS = ['0.2'] as const;

/**
 * Upper bound on an artifact file read off disk — mirrors the 50 MB
 * `maxBuffer` `compileBare` applies to `compile.rb`'s stdout, so the two
 * boot paths accept the same sizes (security gate, #195 F3).
 */
export const MAX_IR_ARTIFACT_BYTES = 50 * 1024 * 1024;

// `returnSchemaId` names an export of the contracts module — an
// identifier. Reserved property names are refused outright: a
// `returnSchemaId` of `__proto__` on a plain-object contracts module would
// resolve to `Object.prototype`, and AJV happily compiles that into a
// validator that accepts anything (security gate, #195 F1). The runner's
// lookup is own-property-only too; this check is the fail-fast half.
const SCHEMA_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_SCHEMA_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

// Memory decl `name` / `scope` become directory segments under
// `<runsRoot>/memory/` (memory/path.ts). Same regex + length as
// `--memory-key` values (memory/keys.ts#validateSafeSegment) — the runtime
// resolver enforces it regardless of IR origin; this is the fail-fast half
// for artifacts (security gate, #195 F2).
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_\-]{1,128}$/;

/**
 * Thrown by every check in this module. `message` names the artifact
 * (`label` — typically its path), the method key when the defect is
 * inside a `{ method → IR }` map, and the exact defect.
 */
export class IrArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IrArtifactError';
  }
}

export type ParsedIrArtifact =
  | { kind: 'single'; ir: IR }
  | { kind: 'map'; irs: Record<string, IR> };

/**
 * Parse an artifact's raw text and validate every IR it contains.
 *
 * `compile.rb <file> --method <m>` emits a single IR object (top-level
 * `version` string + `entry` object); bare mode (no `--method`) emits a
 * `{ method → IR }` map. Both shapes are recognized here so the same
 * reader serves `cambium serve` (always bare-mode artifacts) and
 * `cambium run --ir` (either shape, DEC-006).
 */
export function parseIrArtifact(text: string, label: string): ParsedIrArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw new IrArtifactError(`${label}: not valid JSON (${e?.message ?? String(e)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IrArtifactError(
      `${label}: expected a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version === 'string' && obj.entry && typeof obj.entry === 'object') {
    assertGenIr(obj, label);
    return { kind: 'single', ir: obj as unknown as IR };
  }

  const irs: Record<string, IR> = {};
  for (const [method, value] of Object.entries(obj)) {
    assertGenIr(value, `${label} (method "${method}")`);
    irs[method] = value as unknown as IR;
  }
  if (Object.keys(irs).length === 0) {
    throw new IrArtifactError(`${label}: empty artifact — no methods found`);
  }
  return { kind: 'map', irs };
}

/**
 * Structural check that `ir` is IR a Ruby-free runtime can execute: the
 * fields `runGenFromIr` / `runServe` read, the version gate, and the
 * DEC-001 closed-IR rule. The closed-IR check runs right after `entry`
 * is confirmed shaped (both gen and Pipeline IRs carry a valid `entry`)
 * so a Pipeline artifact is refused with the DEC-001 wording instead of
 * failing a gen-only structural check (`steps`, `returnSchema`) it was
 * never going to satisfy.
 */
export function assertGenIr(ir: unknown, label: string): asserts ir is IR {
  if (ir === null || typeof ir !== 'object' || Array.isArray(ir)) {
    throw new IrArtifactError(
      `${label}: expected an IR object, got ${Array.isArray(ir) ? 'an array' : typeof ir}`,
    );
  }
  const irInternal = ir as IRInternal;

  if (typeof irInternal.version !== 'string') {
    throw new IrArtifactError(`${label}: missing "version"`);
  }
  if (!(SUPPORTED_IR_VERSIONS as readonly string[]).includes(irInternal.version)) {
    throw new IrArtifactError(
      `${label}: compiled by an unsupported compiler version "${irInternal.version}"; ` +
        `this runner accepts ${SUPPORTED_IR_VERSIONS.join(', ')}`,
    );
  }
  if (!irInternal.entry || typeof irInternal.entry !== 'object') {
    throw new IrArtifactError(`${label}: missing "entry"`);
  }
  if (typeof irInternal.entry.class !== 'string') {
    throw new IrArtifactError(`${label}: "entry.class" must be a string`);
  }
  if (typeof irInternal.entry.method !== 'string') {
    throw new IrArtifactError(`${label}: "entry.method" must be a string`);
  }

  const sites = runtimeCompileSites(ir as IR);
  if (sites.length > 0) {
    throw new IrArtifactError(
      `${label}: "${irInternal.entry.class}" needs Ruby at run time (${sites.join(', ')}) — ` +
        `precompiled artifacts must be closed gen IRs (#195)`,
    );
  }

  if (!Array.isArray(irInternal.steps)) {
    throw new IrArtifactError(`${label}: "steps" must be an array`);
  }
  if (!irInternal.context || typeof irInternal.context !== 'object' || Array.isArray(irInternal.context)) {
    throw new IrArtifactError(`${label}: "context" must be an object`);
  }
  const hasInlineSchema =
    irInternal.returnSchema !== undefined &&
    irInternal.returnSchema !== null &&
    typeof irInternal.returnSchema === 'object';
  const hasSchemaId = typeof irInternal.returnSchemaId === 'string';
  if (hasInlineSchema === hasSchemaId) {
    throw new IrArtifactError(
      `${label}: exactly one of "returnSchema" (object) or "returnSchemaId" (string) must be set`,
    );
  }
  if (hasSchemaId) {
    const id = irInternal.returnSchemaId as string;
    if (!SCHEMA_ID_RE.test(id) || RESERVED_SCHEMA_IDS.has(id)) {
      throw new IrArtifactError(
        `${label}: "returnSchemaId" must name a contracts export (an identifier, not a reserved property name), got ${JSON.stringify(id)}`,
      );
    }
  }

  const memory = irInternal.policies?.memory;
  if (memory !== undefined && memory !== null) {
    if (!Array.isArray(memory)) {
      throw new IrArtifactError(`${label}: "policies.memory" must be an array`);
    }
    memory.forEach((decl: any, i: number) => {
      for (const field of ['name', 'scope'] as const) {
        const v = decl?.[field];
        if (typeof v !== 'string' || !SAFE_SEGMENT_RE.test(v)) {
          throw new IrArtifactError(
            `${label}: policies.memory[${i}].${field} must match /^[a-zA-Z0-9_\\-]{1,128}$/ ` +
              `(it becomes a directory name under runs/memory/), got ${JSON.stringify(v)}`,
          );
        }
      }
    });
  }
}

/**
 * Read and validate an artifact file: size-bounded (`MAX_IR_ARTIFACT_BYTES`),
 * then `parseIrArtifact`. The one read path for `cambium serve
 * --precompiled` / `--ir-dir` and `cambium run --ir`; every failure is an
 * `IrArtifactError` naming the file.
 */
export function readIrArtifactFile(irPath: string): ParsedIrArtifact {
  const abs = resolve(irPath);
  let size: number;
  try {
    size = statSync(abs).size;
  } catch (e: any) {
    throw new IrArtifactError(`${abs}: cannot read artifact (${e?.code ?? e?.message ?? String(e)})`);
  }
  if (size > MAX_IR_ARTIFACT_BYTES) {
    throw new IrArtifactError(
      `${abs}: artifact is ${size} bytes, over the ${MAX_IR_ARTIFACT_BYTES}-byte limit ` +
        `(the same 50 MB bound compile-at-boot applies to compile.rb output)`,
    );
  }
  return parseIrArtifact(readFileSync(abs, 'utf8'), abs);
}

/**
 * Run-time compile sites a gen's IR still depends on — pipelines,
 * `enrich`, and retro memory-write agents each spawn Ruby to compile a
 * sub-agent's IR at request time (#195 DEC-001). A precompiled artifact
 * must have none of these; callers (serve boot, `run --ir`) refuse to
 * load an IR where this is non-empty.
 */
export function runtimeCompileSites(ir: IR): string[] {
  const irInternal = ir as IRInternal;
  const sites: string[] = [];
  if (irInternal?.kind === 'Pipeline') sites.push('pipeline');
  if (Array.isArray(irInternal?.enrichments) && irInternal.enrichments.length > 0) sites.push('enrich');
  if (irInternal?.policies?.memory_write_via) sites.push('writes_memory_via');
  return sites;
}

/**
 * `true` when `ir` name-refs a schema by symbol (`returns :Symbol`) and
 * so needs a contracts module injected at run time, rather than
 * carrying its schema inline (`returns do … end`, RED-419).
 */
export function needsContracts(ir: IR): boolean {
  const irInternal = ir as IRInternal;
  return typeof irInternal?.returnSchemaId === 'string' && irInternal?.returnSchema === undefined;
}

/**
 * Override the IR's single context key with per-call input. Moved
 * verbatim from `serve.ts`'s private `injectInput` (#195) — the single
 * definition of "override the one context key", now shared by serve
 * dispatch and `cambium run --ir` (DEC-006).
 *
 * The compile-time IR has exactly one context key (set by compile.rb,
 * either `grounded_in :name`'s source or the default 'document'). Per-call
 * input overrides it.
 */
export function injectContextInput(ir: IR, input: unknown): void {
  const irInternal = ir as IRInternal;
  const ctx = irInternal.context;
  if (!ctx || typeof ctx !== 'object') return;
  const keys = Object.keys(ctx);
  if (keys.length === 0) return;
  const key = keys[0];
  if (typeof input === 'string') {
    ctx[key] = input;
  } else if (input === undefined || input === null) {
    ctx[key] = '';
  } else {
    // dicts/lists JSON-stringify so the runner sees a string in context,
    // matching the existing `cambium run --arg <file>` convention.
    ctx[key] = JSON.stringify(input);
  }
}

/**
 * Where a precompiled artifact anchors its discovery (#195 DEC-005, A-001).
 *
 * A shipped IR's `entry.source` is a build-machine path; the artifact's
 * own location is the anchor that is true on every machine. This is the
 * one exported statement of that rule — `cambium run --ir` consumes it,
 * and `cambium serve --precompiled` applies the same rule with the serve
 * workspace as the anchor. The walk-up helpers behind it stay
 * package-private (they are not a promised surface; this function is).
 */
export interface ArtifactAnchors {
  /** Engine folder (RED-287 `cambium.engine.json` sentinel) found by
   *  walking up from the artifact's directory, or `null`. */
  engineDir: string | null;
  /** Workspace — the nearest `Genfile.toml` above the artifact — or `null`. */
  appRoot: string | null;
  /** App mode only: whether `appRoot` declares `[types].contracts`. `null`
   *  in engine mode (schemas come from `<engineDir>/schemas.ts`) or when
   *  there is no workspace. */
  contractsDeclared: boolean | null;
}

export function resolveArtifactAnchors(irPath: string): ArtifactAnchors {
  const irAbsPath = resolve(irPath);
  const engineDir = findEngineDirFromCwd(dirname(irAbsPath));
  const appRoot = findGenfileDir(irAbsPath);
  let contractsDeclared: boolean | null = null;
  if (!engineDir && appRoot) {
    try {
      contractsDeclared = resolveGenfileContracts(appRoot) !== null;
    } catch (e: any) {
      // Malformed Genfile, or a declared contracts file missing on disk —
      // both are artifact-workspace defects, surfaced with the artifact's
      // label like every other failure in this module.
      throw new IrArtifactError(`${irAbsPath}: workspace ${appRoot} — ${e?.message ?? String(e)}`);
    }
  }
  return { engineDir, appRoot, contractsDeclared };
}
