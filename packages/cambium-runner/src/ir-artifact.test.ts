import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseIrArtifact,
  assertGenIr,
  runtimeCompileSites,
  needsContracts,
  injectContextInput,
  IrArtifactError,
  SUPPORTED_IR_VERSIONS,
  type ParsedIrArtifact,
} from './ir-artifact.js';
import type { IR } from './runner.js';

// A minimal, valid gen IR — the shape `compile.rb`'s `build_ir` emits.
// Cast through `any` (mirrors the `IRInternal = any` convention) since
// `IR` is an opaque phantom-branded type at the public boundary.
function baseIr(overrides: Record<string, unknown> = {}): any {
  return {
    version: '0.2',
    entry: { class: 'TestGen', method: 'analyze', source: '/tmp/test_gen.cmb.rb' },
    model: { id: 'omlx:stub' },
    system: 'test',
    mode: null,
    policies: {
      tools_allowed: [],
      correctors: [],
      constraints: {},
      grounding: null,
      security: null,
      budget: null,
      memory: null,
      memory_pools: null,
      memory_write_via: null,
      log: [],
      log_profiles: [],
      schedules: null,
    },
    reads_trace_of: null,
    returnSchemaId: 'AnalysisReport',
    context: { document: 'hello' },
    enrichments: [],
    signals: [],
    triggers: [],
    steps: [{ type: 'Generate' }],
    ...overrides,
  };
}

describe('parseIrArtifact — single vs map detection (#195 DEC-003)', () => {
  it('recognizes a single IR by top-level version + entry', () => {
    const parsed = parseIrArtifact(JSON.stringify(baseIr()), 'artifact.ir.json');
    expect(parsed.kind).toBe('single');
    if (parsed.kind === 'single') {
      expect((parsed.ir as any).entry.class).toBe('TestGen');
    }
  });

  it('recognizes a { method → IR } map when no top-level version/entry pair exists', () => {
    const map = { analyze: baseIr(), summarize: baseIr({ entry: { class: 'TestGen', method: 'summarize' } }) };
    const parsed = parseIrArtifact(JSON.stringify(map), 'artifact.ir.json');
    expect(parsed.kind).toBe('map');
    if (parsed.kind === 'map') {
      expect(Object.keys(parsed.irs).sort()).toEqual(['analyze', 'summarize']);
    }
  });

  it('rejects malformed JSON', () => {
    expect(() => parseIrArtifact('{not json', 'bad.ir.json')).toThrow(IrArtifactError);
    expect(() => parseIrArtifact('{not json', 'bad.ir.json')).toThrow(/not valid JSON/);
  });

  it('rejects a top-level array', () => {
    expect(() => parseIrArtifact('[1,2,3]', 'array.ir.json')).toThrow(/expected a JSON object/);
  });

  it('rejects an empty map', () => {
    expect(() => parseIrArtifact('{}', 'empty.ir.json')).toThrow(/empty artifact/);
  });

  it('map-mode error messages name the offending method key', () => {
    const map = { analyze: baseIr(), broken: { version: '0.2' } };
    expect(() => parseIrArtifact(JSON.stringify(map), 'artifact.ir.json')).toThrow(
      /artifact\.ir\.json \(method "broken"\)/,
    );
  });
});

describe('assertGenIr — structural defects (#195 DEC-003)', () => {
  it('accepts a well-formed gen IR', () => {
    expect(() => assertGenIr(baseIr(), 'ok.ir.json')).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => assertGenIr('nope', 'x.ir.json')).toThrow(/expected an IR object/);
    expect(() => assertGenIr(null, 'x.ir.json')).toThrow(/expected an IR object/);
    expect(() => assertGenIr([1, 2], 'x.ir.json')).toThrow(/expected an IR object/);
  });

  it('rejects a missing version', () => {
    const ir = baseIr();
    delete ir.version;
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/missing "version"/);
  });

  it('rejects an unsupported version (too old)', () => {
    const ir = baseIr({ version: '0.1' });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(
      /compiled by an unsupported compiler version "0\.1"; this runner accepts 0\.2/,
    );
  });

  it('rejects an unsupported version (too new)', () => {
    const ir = baseIr({ version: '0.3' });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/unsupported compiler version "0\.3"/);
  });

  it('SUPPORTED_IR_VERSIONS is the exact-match set the message quotes', () => {
    expect(SUPPORTED_IR_VERSIONS).toEqual(['0.2']);
  });

  it('rejects a missing entry', () => {
    const ir = baseIr();
    delete ir.entry;
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/missing "entry"/);
  });

  it('rejects entry.class not a string', () => {
    const ir = baseIr({ entry: { class: 42, method: 'analyze' } });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/"entry\.class" must be a string/);
  });

  it('rejects entry.method not a string', () => {
    const ir = baseIr({ entry: { class: 'TestGen', method: null } });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/"entry\.method" must be a string/);
  });

  it('rejects a non-array steps', () => {
    const ir = baseIr({ steps: 'nope' });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/"steps" must be an array/);
  });

  it('rejects a non-object context', () => {
    const ir = baseIr({ context: 'nope' });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/"context" must be an object/);
  });

  it('rejects context as an array', () => {
    const ir = baseIr({ context: [] });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/"context" must be an object/);
  });

  it('rejects both returnSchema and returnSchemaId set', () => {
    const ir = baseIr({ returnSchema: { $id: 'X', type: 'object' }, returnSchemaId: 'X' });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(
      /exactly one of "returnSchema".*"returnSchemaId".*must be set/,
    );
  });

  it('rejects neither returnSchema nor returnSchemaId set', () => {
    const ir = baseIr({ returnSchemaId: undefined });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(
      /exactly one of "returnSchema".*"returnSchemaId".*must be set/,
    );
  });

  it('rejects returnSchemaId: null (present but not a string) with no returnSchema', () => {
    const ir = baseIr({ returnSchemaId: null });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/exactly one of/);
  });

  it('accepts an inline returnSchema (block-form, RED-419) with no returnSchemaId', () => {
    const ir = baseIr({ returnSchema: { $id: 'TestGenOutput', type: 'object' }, returnSchemaId: undefined });
    expect(() => assertGenIr(ir, 'x.ir.json')).not.toThrow();
  });

  it('a Pipeline IR is refused with the DEC-001 wording, not a gen-shape structural error', () => {
    const pipelineIr = {
      version: '0.2',
      kind: 'Pipeline',
      name: 'TestPipeline',
      entry: { class: 'TestPipeline', method: 'run', source: '/tmp/p.pipeline.rb' },
      // Deliberately no `steps`/`context`/`returnSchema*` — Pipeline IRs
      // don't carry them. The refusal must fire before any of the
      // gen-only structural checks would (falsely) trip.
    };
    expect(() => assertGenIr(pipelineIr, 'p.ir.json')).toThrow(/needs Ruby at run time \(pipeline\)/);
    expect(() => assertGenIr(pipelineIr, 'p.ir.json')).toThrow(/"TestPipeline"/);
  });

  it('an enrich gen is refused with the DEC-001 wording', () => {
    const ir = baseIr({ enrichments: [{ field: 'summary_enriched' }] });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/needs Ruby at run time \(enrich\)/);
  });

  it('a retro memory-write gen is refused with the DEC-001 wording', () => {
    const ir = baseIr({ policies: { ...baseIr().policies, memory_write_via: 'MemoryWriter' } });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/needs Ruby at run time \(writes_memory_via\)/);
  });

  it('names every offending site when a gen somehow has more than one', () => {
    const ir = baseIr({
      enrichments: [{ field: 'x' }],
      policies: { ...baseIr().policies, memory_write_via: 'MemoryWriter' },
    });
    expect(() => assertGenIr(ir, 'x.ir.json')).toThrow(/needs Ruby at run time \(enrich, writes_memory_via\)/);
  });
});

describe('runtimeCompileSites (#195 DEC-001)', () => {
  it('returns an empty list for a closed gen IR', () => {
    expect(runtimeCompileSites(baseIr() as IR)).toEqual([]);
  });

  it('detects a Pipeline IR', () => {
    expect(runtimeCompileSites({ kind: 'Pipeline' } as unknown as IR)).toEqual(['pipeline']);
  });

  it('detects a non-empty enrichments list', () => {
    expect(runtimeCompileSites(baseIr({ enrichments: [{ field: 'x' }] }) as IR)).toEqual(['enrich']);
  });

  it('does not flag an empty enrichments list', () => {
    expect(runtimeCompileSites(baseIr({ enrichments: [] }) as IR)).toEqual([]);
  });

  it('detects policies.memory_write_via', () => {
    const ir = baseIr({ policies: { ...baseIr().policies, memory_write_via: 'MemoryWriter' } });
    expect(runtimeCompileSites(ir as IR)).toEqual(['writes_memory_via']);
  });

  it('does not flag a null memory_write_via', () => {
    expect(runtimeCompileSites(baseIr() as IR)).toEqual([]);
  });
});

describe('needsContracts (#195 DEC-003)', () => {
  it('true for a symbol-form gen (returnSchemaId set, no returnSchema)', () => {
    expect(needsContracts(baseIr() as IR)).toBe(true);
  });

  it('false for a block-form gen (returnSchema inline, RED-419)', () => {
    const ir = baseIr({ returnSchema: { $id: 'X', type: 'object' }, returnSchemaId: undefined });
    expect(needsContracts(ir as IR)).toBe(false);
  });

  it('false when returnSchemaId is absent entirely', () => {
    const ir = baseIr({ returnSchemaId: undefined, returnSchema: { $id: 'X', type: 'object' } });
    expect(needsContracts(ir as IR)).toBe(false);
  });
});

describe('injectContextInput (#195 DEC-003, moved verbatim from serve.ts)', () => {
  it('overrides the sole context key with a string input', () => {
    const ir: any = { context: { document: 'original' } };
    injectContextInput(ir as IR, 'replacement text');
    expect(ir.context.document).toBe('replacement text');
  });

  it('JSON-stringifies an object/array input', () => {
    const ir: any = { context: { document: 'original' } };
    injectContextInput(ir as IR, { a: 1, b: [2, 3] });
    expect(ir.context.document).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
  });

  it('sets an empty string for null input', () => {
    const ir: any = { context: { document: 'original' } };
    injectContextInput(ir as IR, null);
    expect(ir.context.document).toBe('');
  });

  it('sets an empty string for undefined input', () => {
    const ir: any = { context: { document: 'original' } };
    injectContextInput(ir as IR, undefined);
    expect(ir.context.document).toBe('');
  });

  it('is a no-op when the IR has no context object', () => {
    const ir: any = {};
    expect(() => injectContextInput(ir as IR, 'x')).not.toThrow();
    expect(ir.context).toBeUndefined();
  });

  it('is a no-op when context has no keys', () => {
    const ir: any = { context: {} };
    injectContextInput(ir as IR, 'x');
    expect(ir.context).toEqual({});
  });

  it('overrides only the first (sole) context key', () => {
    const ir: any = { context: { grounded_source: 'orig' } };
    injectContextInput(ir as IR, 'new value');
    expect(ir.context.grounded_source).toBe('new value');
  });
});

// ── A-001: resolveArtifactAnchors (the one promised anchoring export) ───
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, writeSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveArtifactAnchors } from './ir-artifact.js';

describe('resolveArtifactAnchors (#195 DEC-005 / A-001)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cambium-anchors-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('app mode with [types]: appRoot is the nearest Genfile dir, contractsDeclared true, no engineDir', () => {
    mkdirSync(join(tmp, 'ws/dist/ir'), { recursive: true });
    mkdirSync(join(tmp, 'ws/src'), { recursive: true });
    writeFileSync(join(tmp, 'ws/src/contracts.ts'), 'export const X = {};\n');
    writeFileSync(join(tmp, 'ws/Genfile.toml'), '[package]\nname = "a"\n\n[types]\ncontracts = ["src/contracts.ts"]\n');
    const a = resolveArtifactAnchors(join(tmp, 'ws/dist/ir/x.ir.json'));
    expect(a.engineDir).toBeNull();
    expect(a.appRoot).toBe(join(tmp, 'ws'));
    expect(a.contractsDeclared).toBe(true);
  });

  it('app mode without [types]: contractsDeclared false', () => {
    mkdirSync(join(tmp, 'ws/app/gens'), { recursive: true });
    writeFileSync(join(tmp, 'ws/Genfile.toml'), '[package]\nname = "a"\n');
    const a = resolveArtifactAnchors(join(tmp, 'ws/app/gens/x.ir.json'));
    expect(a.appRoot).toBe(join(tmp, 'ws'));
    expect(a.contractsDeclared).toBe(false);
  });

  it('engine mode: engineDir from the sentinel; contractsDeclared is null even if a Genfile sits above', () => {
    mkdirSync(join(tmp, 'host/engine'), { recursive: true });
    writeFileSync(join(tmp, 'host/Genfile.toml'), '[package]\nname = "host"\n');
    writeFileSync(join(tmp, 'host/engine/cambium.engine.json'), '{}\n');
    const a = resolveArtifactAnchors(join(tmp, 'host/engine/x.ir.json'));
    expect(a.engineDir).toBe(join(tmp, 'host/engine'));
    expect(a.contractsDeclared).toBeNull();
  });

  it('no workspace anywhere above: all null', () => {
    mkdirSync(join(tmp, 'loose'), { recursive: true });
    const a = resolveArtifactAnchors(join(tmp, 'loose/x.ir.json'));
    expect(a).toEqual({ engineDir: null, appRoot: null, contractsDeclared: null });
  });

  it('a malformed Genfile in the artifact workspace throws IrArtifactError naming the artifact', () => {
    mkdirSync(join(tmp, 'ws'), { recursive: true });
    writeFileSync(join(tmp, 'ws/Genfile.toml'), '[types\ncontracts = [\n');
    expect(() => resolveArtifactAnchors(join(tmp, 'ws/x.ir.json'))).toThrow(IrArtifactError);
    expect(() => resolveArtifactAnchors(join(tmp, 'ws/x.ir.json'))).toThrow(/x\.ir\.json/);
  });
});

// ── Security gate (#195 F1/F2/F3): fields that reach a sink, and the size bound ──
import { readIrArtifactFile, MAX_IR_ARTIFACT_BYTES } from './ir-artifact.js';

describe('assertGenIr — sink-bound fields (#195 security gate F1/F2)', () => {
  const base = () => ({
    version: '0.2',
    entry: { class: 'X', method: 'analyze', source: '/nowhere/x.cmb.rb' },
    policies: { memory: [] as any[] },
    steps: [],
    context: { document: '' },
    returnSchemaId: 'Report',
  });

  it('F1: a reserved property name as returnSchemaId is refused', () => {
    for (const id of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']) {
      const ir = { ...base(), returnSchemaId: id };
      expect(() => assertGenIr(ir, 'a.ir.json')).toThrow(/returnSchemaId.*reserved/);
    }
  });

  it('F1: a non-identifier returnSchemaId is refused; an identifier passes', () => {
    expect(() => assertGenIr({ ...base(), returnSchemaId: 'has space' }, 'a.ir.json')).toThrow(/returnSchemaId/);
    expect(() => assertGenIr({ ...base(), returnSchemaId: '../x' }, 'a.ir.json')).toThrow(/returnSchemaId/);
    expect(() => assertGenIr({ ...base(), returnSchemaId: 'Report_v2' }, 'a.ir.json')).not.toThrow();
  });

  it('F2: a memory decl whose name or scope could escape runs/memory/ is refused', () => {
    const bad = (decl: any) => ({ ...base(), policies: { memory: [decl] } });
    expect(() => assertGenIr(bad({ name: '../../evil', scope: 'global', strategy: 'log' }), 'a.ir.json')).toThrow(/policies\.memory\[0\]\.name/);
    expect(() => assertGenIr(bad({ name: 'ok', scope: '../up', strategy: 'log' }), 'a.ir.json')).toThrow(/policies\.memory\[0\]\.scope/);
    expect(() => assertGenIr(bad({ name: 'ok', scope: 'global', strategy: 'log' }), 'a.ir.json')).not.toThrow();
    expect(() => assertGenIr(bad({ name: 'a'.repeat(129), scope: 'global', strategy: 'log' }), 'a.ir.json')).toThrow(/policies\.memory\[0\]\.name/);
  });
});

describe('readIrArtifactFile — size bound (#195 security gate F3)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cambium-artifact-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('reads and parses a normal artifact', () => {
    const ir = { version: '0.2', entry: { class: 'X', method: 'analyze', source: '/n/x.cmb.rb' }, steps: [], context: { document: '' }, returnSchema: { type: 'object' } };
    writeFileSync(join(tmp, 'x.ir.json'), JSON.stringify({ analyze: ir }));
    const parsed = readIrArtifactFile(join(tmp, 'x.ir.json'));
    expect(parsed.kind).toBe('map');
  });

  it('refuses an artifact over MAX_IR_ARTIFACT_BYTES before parsing it', () => {
    // A sparse file: the size is what is checked; no 50 MB of JSON is written.
    const fd = openSync(join(tmp, 'huge.ir.json'), 'w');
    writeSync(fd, '{', 0);
    ftruncateSync(fd, MAX_IR_ARTIFACT_BYTES + 1);
    closeSync(fd);
    expect(() => readIrArtifactFile(join(tmp, 'huge.ir.json'))).toThrow(/over the .* limit/);
  });

  it('names the file when it cannot be read', () => {
    expect(() => readIrArtifactFile(join(tmp, 'missing.ir.json'))).toThrow(/missing\.ir\.json: cannot read artifact/);
  });
});
