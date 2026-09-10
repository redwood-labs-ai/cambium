/**
 * #198: `cambium mcp` — MCP-stdio ↔ `/v1`-HTTP adapter.
 *
 * Framing/lifecycle (STEP-002), tools/list derivation (STEP-003), and
 * tools/call dispatch + error mapping (STEP-004) all boot a REAL
 * `runServe` in-process (DEC-001) against a tmp fixture workspace, then
 * drive the protocol over injected `input`/`output` streams — no real
 * process, no real stdio (DEC-010). The pure derivation functions
 * (`deriveInputShape` / `buildInputSchema` / `buildToolTable`) are also
 * exercised directly against hand-built catalog entries, covering the
 * gen / 0-slot / 1-slot / N-slot pipeline shapes STEP-003 asks for
 * without needing to compile a multi-slot Ruby pipeline fixture for each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { RunGenFromIrFn } from '../serve/serve.js';
import type { GenCatalogWireEntry } from '../serve/serve.js';
import {
  runMcpStdio,
  deriveInputShape,
  buildInputSchema,
  buildToolTable,
  listTools,
  validateToolInput,
  type McpStdioHandle,
  type ToolTableEntry,
} from './mcp-stdio.js';

// ── fixture workspace (mirrors serve.test.ts's own conventions) ────────

const FIXTURE_GEN = `
class TestGen < GenModel
  model "ollama:test"
  system "test prompt"
  returns AnalysisReport

  def analyze(doc)
    generate "analyze the document" do
      with context: doc
      returns AnalysisReport
    end
  end
end
`;

const FIXTURE_CONTRACTS = `
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  additionalProperties: true,
};
`;

function setupWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-mcp-fixture-'));
  mkdirSync(join(dir, 'app/gens'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'app/gens/test_gen.cmb.rb'), FIXTURE_GEN);
  writeFileSync(join(dir, 'src/contracts.ts'), FIXTURE_CONTRACTS);
  writeFileSync(
    join(dir, 'Genfile.toml'),
    `[types]\ncontracts = ["src/contracts.ts"]\n\n[exports.gens]\nTestGen = "app/gens/test_gen.cmb.rb"\n`,
  );
  return dir;
}

/** A tiny JSON-RPC line-oriented test harness over injected streams. */
function makeHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buf = '';
  output.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });

  function send(msg: unknown): void {
    input.write(`${JSON.stringify(msg)}\n`);
  }
  function sendRaw(line: string): void {
    input.write(`${line}\n`);
  }
  async function waitForLine(predicate: (parsed: any, raw: string) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const raw of lines) {
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (predicate(parsed, raw)) return parsed;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a matching line. Seen:\n${lines.join('\n')}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async function waitForId(id: unknown): Promise<any> {
    return waitForLine((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
  }

  return { input, output, send, sendRaw, waitForLine, waitForId, lines };
}

describe('runMcpStdio — framing + lifecycle (DEC-004/005/009)', () => {
  let tmp: string;
  let handle: McpStdioHandle | undefined;

  beforeEach(() => {
    tmp = setupWorkspace();
  });
  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });

  it('initialize round-trips: echoes a known protocolVersion, reports capabilities.tools + serverInfo', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const resp = await h.waitForId(1);
    expect(resp.result.protocolVersion).toBe('2025-03-26');
    expect(resp.result.capabilities).toEqual({ tools: {} });
    expect(resp.result.serverInfo.name).toBe('cambium');
    expect(typeof resp.result.serverInfo.version).toBe('string');
  });

  it('initialize with an unknown protocolVersion falls back to the server default', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    const resp = await h.waitForId(1);
    expect(resp.result.protocolVersion).toBe('2025-06-18');
  });

  it('notifications/initialized draws no response', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Follow it with a real request; if a stray response to the
    // notification had been written, it would show up before this one.
    h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const resp = await h.waitForId(9);
    expect(resp.result).toEqual({});
    expect(h.lines).toHaveLength(1);
  });

  it('ping responds with an empty object', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const resp = await h.waitForId(2);
    expect(resp.result).toEqual({});
  });

  it('unknown method → -32601, unknown notification (no id) is silently ignored', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', method: 'notifications/unknown-thing' });
    h.send({ jsonrpc: '2.0', id: 3, method: 'nonexistent/method' });
    const resp = await h.waitForId(3);
    expect(resp.error.code).toBe(-32601);
    expect(h.lines).toHaveLength(1); // the unknown notification drew nothing
  });

  it('a JSON-array (batch) request is rejected with -32600, id: null', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.sendRaw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
    const resp = await h.waitForLine((m) => m.error?.code === -32600);
    expect(resp.id).toBeNull();
  });

  it('malformed JSON → -32700, id: null', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.sendRaw('{not valid json');
    const resp = await h.waitForLine((m) => m.error?.code === -32700);
    expect(resp.id).toBeNull();
  });

  it('a request with jsonrpc !== "2.0" is rejected with -32600 (AUD-198-06)', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '1.0', id: 7, method: 'ping' });
    const resp = await h.waitForId(7);
    expect(resp.error.code).toBe(-32600);
    expect(resp.error.message).toMatch(/jsonrpc/);
  });

  it('a request with an object id is rejected with -32600, id: null (AUD-198-06)', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', id: { nope: true }, method: 'ping' });
    const resp = await h.waitForLine((m) => m.error?.code === -32600 && /id/.test(m.error.message ?? ''));
    expect(resp.id).toBeNull();
  });

  it('requests answered before initialize (pre-initialize leniency, KEPT per AUD-198-06)', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    // No `initialize` was sent — `tools/list` still answers normally.
    h.send({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    const resp = await h.waitForId(8);
    expect(resp.result.tools).toBeDefined();
  });

  it('an oversized stdin line (>16 MiB) triggers a -32700-class cap error and resyncs on the next newline (DEC-012)', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    // One line, no embedded newline, over the 16 MiB cap — written as two
    // chunks (the oversized body, then its own terminating newline) so
    // the cap fires mid-line and the newline is what resyncs the stream.
    h.input.write('x'.repeat(16 * 1024 * 1024 + 1));
    h.input.write('\n');
    const capError = await h.waitForLine((m) => m.error?.code === -32700 && /16 MiB/.test(m.error?.message ?? ''));
    expect(capError.id).toBeNull();

    // Resync proof: a normal frame right after the oversized one is
    // still answered — the process kept serving, nothing wedged.
    h.send({ jsonrpc: '2.0', id: 99, method: 'ping' });
    const resp = await h.waitForId(99);
    expect(resp.result).toEqual({});
  });

  it('queues a message sent before boot completes, and answers it once ready', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    // Fire before awaiting ready — the line lands on the readline
    // listener while boot is still in flight.
    h.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await handle.ready;
    const resp = await h.waitForId(5);
    expect(resp.result).toEqual({});
  });

  it('closed resolves once input hits EOF, and cleans up the socket dir', async () => {
    const before = new Set(readdirSync(tmpdir()));
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;
    const created = readdirSync(tmpdir()).filter((n) => n.startsWith('cambium-mcp-') && !before.has(n));
    expect(created).toHaveLength(1);
    const socketDir = join(tmpdir(), created[0]);
    expect(existsSync(socketDir)).toBe(true);

    h.input.end();
    await handle.closed;
    expect(existsSync(socketDir)).toBe(false);
  });

  it('close() is idempotent', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;
    await handle.close();
    await handle.close();
  });

  it('boot rejects when the workspace has no Genfile.toml', async () => {
    const badWs = mkdtempSync(join(tmpdir(), 'cambium-mcp-bad-'));
    const h = makeHarness();
    const badHandle = runMcpStdio({ workspaceDir: badWs, input: h.input, output: h.output });
    await expect(badHandle.ready).rejects.toThrow(/Genfile\.toml/);
    await badHandle.close();
    rmSync(badWs, { recursive: true, force: true });
  });
});

describe('deriveInputShape / buildInputSchema (DEC-007)', () => {
  function genEntry(overrides: Partial<GenCatalogWireEntry> = {}): GenCatalogWireEntry {
    return {
      name: 'DocGen',
      kind: 'gen',
      description: null,
      methods: ['analyze'],
      returns: { analyze: null },
      model: { id: 'ollama:test', fallbacks: null },
      budget: null,
      egress: { network: 'none', allowlist: null },
      exec: null,
      example: { gen: 'DocGen', method: 'analyze', input: '<document>' },
      ...overrides,
    } as GenCatalogWireEntry;
  }

  it('gen: string shape, description names the harvested context key', () => {
    const entry = genEntry();
    const shape = deriveInputShape(entry);
    expect(shape).toEqual({ mode: 'string', noun: "the gen's document context" });
    const schema = buildInputSchema(shape);
    expect(schema).toEqual({
      type: 'object',
      properties: { input: { type: 'string', description: "Content for the gen's document context" } },
      required: ['input'],
    });
  });

  it('pipeline, 0 slots: optional string, required: []', () => {
    const entry = genEntry({ kind: 'pipeline', example: { gen: 'P', method: 'run', input: '' } });
    const shape = deriveInputShape(entry);
    expect(shape).toEqual({ mode: 'optionalString' });
    const schema: any = buildInputSchema(shape);
    expect(schema.required).toEqual([]);
    expect(schema.properties.input.type).toBe('string');
  });

  it('pipeline, 1 slot: string shape naming the slot', () => {
    const entry = genEntry({ kind: 'pipeline', example: { gen: 'P', method: 'run', input: '<doc>' } });
    const shape = deriveInputShape(entry);
    expect(shape).toEqual({ mode: 'string', noun: "the pipeline's doc input" });
    const schema: any = buildInputSchema(shape);
    expect(schema.required).toEqual(['input']);
  });

  it('pipeline, N>=2 slots: input is a nested object schema, all slots required', () => {
    const entry = genEntry({
      kind: 'pipeline',
      example: { gen: 'P', method: 'run', input: { a: '<a>', b: '<b>' } },
    });
    const shape = deriveInputShape(entry);
    expect(shape).toEqual({ mode: 'object', slots: ['a', 'b'] });
    const schema: any = buildInputSchema(shape);
    expect(schema.required).toEqual(['input']);
    expect(schema.properties.input).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('pipeline, N>=2 slots: advertised schema carries additionalProperties: false (AUD-198-F1) — matches validateToolInput\'s exact-keys enforcement, not looser', () => {
    const entry = genEntry({
      kind: 'pipeline',
      example: { gen: 'P', method: 'run', input: { a: '<a>', b: '<b>' } },
    });
    const shape = deriveInputShape(entry);
    const schema: any = buildInputSchema(shape);
    expect(schema.properties.input.additionalProperties).toBe(false);
  });
});

describe('schema/validator parity — advertised inputSchema never accepts what validateToolInput rejects (AUD-198-F1)', () => {
  function tableEntryFor(shape: ToolTableEntry['shape']): ToolTableEntry {
    return {
      gen: 'X',
      method: 'm',
      shape,
      inputSchema: buildInputSchema(shape),
      description: 'Run X.m',
    };
  }

  // A tiny, hand-rolled structural checker over the closed subset of
  // JSON Schema `buildInputSchema` actually emits (object/string props,
  // `required`, `additionalProperties`) — no AJV, mirroring the "no new
  // dep" reasoning `validateToolInput` itself uses (DEC-011).
  function schemaAccepts(schema: any, value: unknown): boolean {
    if (schema.type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
      }
      if (schema.additionalProperties === false) {
        const declared = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(obj)) {
          if (!declared.has(key)) return false;
        }
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && !schemaAccepts(sub, obj[key])) return false;
      }
      return true;
    }
    if (schema.type === 'string') return typeof value === 'string';
    return true;
  }

  const cases: Array<{ label: string; shape: ToolTableEntry['shape']; args: Record<string, unknown> }> = [
    { label: 'gen/1-slot: extra top-level key', shape: { mode: 'string', noun: 'x' }, args: { input: 'a', extra: 1 } },
    { label: '0-slot: non-string input', shape: { mode: 'optionalString' }, args: { input: 42 } },
    {
      label: 'N-slot: extra slot key',
      shape: { mode: 'object', slots: ['a', 'b'] },
      args: { input: { a: '1', b: '2', c: '3' } },
    },
    {
      label: 'N-slot: missing slot',
      shape: { mode: 'object', slots: ['a', 'b'] },
      args: { input: { a: '1' } },
    },
  ];

  it.each(cases)('$label: whatever the advertised schema rejects, the validator also rejects', ({ shape, args }) => {
    const entry = tableEntryFor(shape);
    const schemaOk = schemaAccepts(entry.inputSchema, args);
    const validatorOk = validateToolInput(entry, args).ok;
    // The invariant this suite exists to pin: the validator is never
    // LOOSER than what the tool's own advertised schema promises. (It
    // may be stricter — e.g. slot value types — schemaAccepts here only
    // covers the shapes buildInputSchema actually emits.)
    if (!schemaOk) expect(validatorOk).toBe(false);
  });
});

describe('validateToolInput (DEC-011, closes AUD-198-01)', () => {
  function tableEntry(shape: ToolTableEntry['shape']): ToolTableEntry {
    return {
      gen: 'X',
      method: 'm',
      shape,
      inputSchema: {},
      description: 'Run X.m',
    };
  }

  it('gen / 1-slot pipeline (string shape): accepts a string input, rejects missing or non-string', () => {
    const entry = tableEntry({ mode: 'string', noun: "the gen's document context" });
    expect(validateToolInput(entry, { input: 'hello' })).toEqual({ ok: true, value: 'hello' });
    expect(validateToolInput(entry, {})).toEqual({
      ok: false,
      message: "X__m: field 'input' is required and must be a string",
    });
    expect(validateToolInput(entry, { input: { a: 1 } })).toEqual({
      ok: false,
      message: "X__m: field 'input' is required and must be a string",
    });
  });

  it('N-slot pipeline (object shape): accepts an object with exactly the declared slots, each a string', () => {
    const entry = tableEntry({ mode: 'object', slots: ['a', 'b'] });
    expect(validateToolInput(entry, { input: { a: '1', b: '2' } })).toEqual({
      ok: true,
      value: { a: '1', b: '2' },
    });
  });

  it('N-slot pipeline: rejects a non-object input, a missing slot, an extra key, and a non-string slot value', () => {
    const entry = tableEntry({ mode: 'object', slots: ['a', 'b'] });
    expect(validateToolInput(entry, { input: 'not an object' }).ok).toBe(false);
    expect(validateToolInput(entry, { input: { a: '1' } })).toEqual({
      ok: false,
      message: "X__m: field 'input.b' is required",
    });
    expect(validateToolInput(entry, { input: { a: '1', b: '2', c: '3' } })).toEqual({
      ok: false,
      message: "X__m: field 'input.c' is not a declared slot (expected: a, b)",
    });
    expect(validateToolInput(entry, { input: { a: 1, b: '2' } })).toEqual({
      ok: false,
      message: "X__m: field 'input.a' must be a string",
    });
  });

  it('0-slot pipeline (optionalString shape): input is optional, but must be a string when present', () => {
    const entry = tableEntry({ mode: 'optionalString' });
    expect(validateToolInput(entry, {})).toEqual({ ok: true, value: '' });
    expect(validateToolInput(entry, { input: 'hi' })).toEqual({ ok: true, value: 'hi' });
    expect(validateToolInput(entry, { input: 42 })).toEqual({
      ok: false,
      message: "X__m: field 'input' must be a string when present",
    });
  });
});

describe('buildToolTable (DEC-006)', () => {
  function entry(overrides: Partial<GenCatalogWireEntry>): GenCatalogWireEntry {
    return {
      name: 'X',
      kind: 'gen',
      description: null,
      methods: ['m'],
      returns: { m: null },
      model: { id: 'ollama:test', fallbacks: null },
      budget: null,
      egress: { network: 'none', allowlist: null },
      exec: null,
      example: { gen: 'X', method: 'm', input: '<doc>' },
      ...overrides,
    } as GenCatalogWireEntry;
  }

  it('names each tool <GenName>__<method>; multi-method entries get a distinguishing suffix', () => {
    const table = buildToolTable([
      entry({ name: 'Multi', methods: ['analyze', 'summarize'], returns: { analyze: null, summarize: null } }),
    ]);
    expect(Array.from(table.keys()).sort()).toEqual(['Multi__analyze', 'Multi__summarize']);
    expect(table.get('Multi__analyze')!.description).toBe('Run Multi.analyze (method: analyze)');
    expect(table.get('Multi__summarize')!.description).toBe('Run Multi.summarize (method: summarize)');
  });

  it('single-method entries get the bare description (no method suffix), described entries pass description through', () => {
    const table = buildToolTable([entry({ name: 'Solo', description: 'Extract facts.' })]);
    expect(table.get('Solo__m')!.description).toBe('Extract facts.');
  });

  it('falls back to "Run <Gen>.<method>" when the catalog has no description', () => {
    const table = buildToolTable([entry({ name: 'Bare' })]);
    expect(table.get('Bare__m')!.description).toBe('Run Bare.m');
  });

  it('outputSchema is present when returns[method] is non-null, omitted (not null) otherwise', () => {
    const table = buildToolTable([
      entry({ name: 'HasSchema', returns: { m: { type: 'object' } } }),
      entry({ name: 'NoSchema', returns: { m: null } }),
    ]);
    expect(table.get('HasSchema__m')!.outputSchema).toEqual({ type: 'object' });
    expect(Object.prototype.hasOwnProperty.call(table.get('NoSchema__m')!, 'outputSchema')).toBe(true);
    expect(table.get('NoSchema__m')!.outputSchema).toBeUndefined();
    const tools = listTools(table) as any[];
    const noSchemaTool = tools.find((t) => t.name === 'NoSchema__m');
    expect(Object.prototype.hasOwnProperty.call(noSchemaTool, 'outputSchema')).toBe(false);
  });

  it('a realistic cross-gen collision fails boot, naming both sources (AUD-198-05)', () => {
    // Two DIFFERENT catalog names — the shape that can actually reach
    // buildToolTable from a real /v1/gens catalog (serve enforces
    // per-name uniqueness, so two entries can never share `name`, which
    // is why this fixture uses `A__b`/`A` rather than two `Collide`
    // entries). `A__b` method `c` and `A` method `b__c` both map to tool
    // name `A__b__c` under the `<GenName>__<method>` naming scheme —
    // verified working end-to-end against a real boot in the security
    // audit (SECURITY-AUDIT-198-2026-09-08.md § AUD-198-05).
    expect(() =>
      buildToolTable([
        entry({ name: 'A__b', methods: ['c'], returns: { c: null } }),
        entry({ name: 'A', methods: ['b__c'], returns: { b__c: null } }),
      ]),
    ).toThrow(/A__b__c.*A__b\.c.*A\.b__c/s);
  });

  it('a tool name over 64 chars warns to stderr but is still served', () => {
    const longName = 'A'.repeat(60);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const table = buildToolTable([entry({ name: longName, methods: ['analyze'] })]);
      expect(table.has(`${longName}__analyze`)).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('64'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runMcpStdio — tools/list end-to-end over a real boot (DEC-006/007)', () => {
  let tmp: string;
  let handle: McpStdioHandle | undefined;

  beforeEach(() => {
    tmp = setupWorkspace();
  });
  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });

  it('derives the tool table from the real GET /v1/gens catalog', async () => {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output });
    await handle.ready;

    h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const resp = await h.waitForId(1);
    expect(resp.result.tools).toHaveLength(1);
    const tool = resp.result.tools[0];
    expect(tool.name).toBe('TestGen__analyze');
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { input: { type: 'string', description: "Content for the gen's document context" } },
      required: ['input'],
    });
    expect(tool.outputSchema).toBeDefined();
  });
});

describe('runMcpStdio — tools/call dispatch + error mapping (DEC-008)', () => {
  let tmp: string;
  let handle: McpStdioHandle | undefined;

  beforeEach(() => {
    tmp = setupWorkspace();
  });
  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });

  async function bootWith(runGenFromIrFn: RunGenFromIrFn): Promise<{ h: ReturnType<typeof makeHarness> }> {
    const h = makeHarness();
    handle = runMcpStdio({ workspaceDir: tmp, input: h.input, output: h.output, runGenFromIrFn });
    await handle.ready;
    return { h };
  }

  it('success: structuredContent === output, content[0].text is the JSON-stringified output', async () => {
    const output = { summary: 'ok', extra: 42 };
    const { h } = await bootWith(async () =>
      ({ ok: true, output, trace: { steps: [] }, runId: 'r1', schemaId: 'X', ir: {} as any,
         tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any));

    h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'TestGen__analyze', arguments: { input: 'hello' } } });
    const resp = await h.waitForId(1);
    expect(resp.result.isError).toBeUndefined();
    expect(resp.result.structuredContent).toEqual(output);
    expect(JSON.parse(resp.result.content[0].text)).toEqual(output);
  });

  it.each([
    ['validation', 'validation_failed'],
    ['budget', 'budget_exhausted'],
    ['output_ceiling', 'output_ceiling'],
  ] as const)('dispatch failure (failureKind=%s) relays error.kind=%s verbatim in isError content + structuredContent', async (failureKind, expectedKind) => {
    const { h } = await bootWith(async () =>
      ({ ok: false, output: null, errorMessage: 'it broke', failureKind, trace: { steps: [] },
         runId: 'r2', schemaId: 'X', ir: {} as any,
         tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any));

    h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'TestGen__analyze', arguments: { input: 'x' } } });
    const resp = await h.waitForId(2);
    expect(resp.error).toBeUndefined(); // dispatch failures are RESULTS, not JSON-RPC errors (DEC-008)
    expect(resp.result.isError).toBe(true);
    expect(resp.result.structuredContent.error.kind).toBe(expectedKind);
    expect(resp.result.run_id ?? resp.result.structuredContent.run_id).toBeDefined();
    // Byte-equality between the content-text envelope and structuredContent.
    const fromText = JSON.parse(resp.result.content[0].text);
    expect(fromText.error).toEqual(resp.result.structuredContent.error);
  });

  it('a thrown pre-flight error maps through classifyThrownError to tool_dispatch_failed, still a result not a JSON-RPC error', async () => {
    const { h } = await bootWith(async () => {
      throw new Error('Tool "x" declared in policies.tools_allowed but not found in registry');
    });

    h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'TestGen__analyze', arguments: { input: 'x' } } });
    const resp = await h.waitForId(3);
    expect(resp.error).toBeUndefined();
    expect(resp.result.isError).toBe(true);
    expect(resp.result.structuredContent.error.kind).toBe('tool_dispatch_failed');
  });

  it('a gen tool called with no input → -32602, and the dispatch fn is NEVER invoked (DEC-011, load-bearing)', async () => {
    let dispatchCalls = 0;
    const { h } = await bootWith(async () => {
      dispatchCalls++;
      return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
    });

    h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'TestGen__analyze' } });
    const resp = await h.waitForId(5);
    expect(resp.result).toBeUndefined();
    expect(resp.error.code).toBe(-32602);
    expect(resp.error.message).toMatch(/input/);
    expect(dispatchCalls).toBe(0);
  });

  it('a gen tool called with a non-string input → -32602, never dispatched (DEC-011)', async () => {
    let dispatchCalls = 0;
    const { h } = await bootWith(async () => {
      dispatchCalls++;
      return { ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
        tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any;
    });

    h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'TestGen__analyze', arguments: { input: { not: 'a string' } } } });
    const resp = await h.waitForId(6);
    expect(resp.result).toBeUndefined();
    expect(resp.error.code).toBe(-32602);
    expect(dispatchCalls).toBe(0);
  });

  it('unknown tool name → JSON-RPC error -32602 (protocol failure, not a tool result)', async () => {
    const { h } = await bootWith(async () => ({ ok: true, output: {}, trace: { steps: [] }, runId: 'r', schemaId: 'X', ir: {} as any,
      tracePath: '/x', outputPath: '/x', irPath: '/x', runDir: '/x' } as any));

    h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'NoSuchTool__x', arguments: {} } });
    const resp = await h.waitForId(4);
    expect(resp.result).toBeUndefined();
    expect(resp.error.code).toBe(-32602);
  });
});
