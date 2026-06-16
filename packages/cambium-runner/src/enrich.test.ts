/**
 * Tests for the pure helper `resolveEnrichmentInput` (RED-327).
 *
 * The wider enrichment loop is exercised end-to-end via runGen in
 * `corrector-feedback.test.ts` and friends; this file pins the v1
 * routing decision for base64_pdf / base64_image envelopes vs plain
 * context values without spinning up a real sub-agent.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEnrichmentInput, runEnrichment } from './enrich.js';

describe('resolveEnrichmentInput (RED-327)', () => {
  // ── plain values pass through ───────────────────────────────────

  it('passes a plain string through unchanged', () => {
    const r = resolveEnrichmentInput('hello world', 'document', {});
    expect(r).toEqual({ kind: 'use', value: 'hello world' });
  });

  it('passes a plain dict through unchanged', () => {
    const r = resolveEnrichmentInput({ foo: 'bar' }, 'document', {});
    expect(r).toEqual({ kind: 'use', value: { foo: 'bar' } });
  });

  it('passes a plain list through unchanged', () => {
    const r = resolveEnrichmentInput(['a', 'b'], 'document', {});
    expect(r).toEqual({ kind: 'use', value: ['a', 'b'] });
  });

  it('passes null and undefined through unchanged', () => {
    expect(resolveEnrichmentInput(null, 'd', {})).toEqual({ kind: 'use', value: null });
    expect(resolveEnrichmentInput(undefined, 'd', {})).toEqual({ kind: 'use', value: undefined });
  });

  it('does NOT treat an object that happens to have a `kind` field as an envelope unless it matches an envelope kind', () => {
    // A caller's domain object that happens to have `kind: 'invoice'`
    // shouldn't be misclassified.
    const r = resolveEnrichmentInput(
      { kind: 'invoice', total: 100 },
      'document',
      {},
    );
    expect(r).toEqual({ kind: 'use', value: { kind: 'invoice', total: 100 } });
  });

  // ── base64_pdf → extracted text ─────────────────────────────────

  it('routes a base64_pdf envelope to the extracted text', () => {
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'document', {
      document: 'extracted PDF body text',
    });
    expect(r).toEqual({ kind: 'use', value: 'extracted PDF body text' });
  });

  it('routes by the field-specific extracted-text entry', () => {
    // groundingTextByKey is keyed per-field; make sure we look up the
    // right key, not just any string in the map.
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'report', {
      document: 'wrong field',
      report: 'right field',
    });
    expect(r).toEqual({ kind: 'use', value: 'right field' });
  });

  it('returns a skip when a base64_pdf has no extracted text (image-only PDF)', () => {
    // extractDocuments returns empty string or skips the entry if the
    // PDF's text layer is empty. Surface a clear OCR-upstream pointer.
    const envelope = { kind: 'base64_pdf', data: '...', media_type: 'application/pdf' };
    const r = resolveEnrichmentInput(envelope, 'document', {});
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') {
      expect(r.reason).toMatch(/no extractable text/);
      expect(r.reason).toMatch(/OCR upstream/);
    }
  });

  // ── base64_image → always skip ──────────────────────────────────

  it('skips a base64_image envelope with a clear reason', () => {
    const envelope = { kind: 'base64_image', data: '...', media_type: 'image/png' };
    const r = resolveEnrichmentInput(envelope, 'screenshot', {});
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') {
      expect(r.reason).toMatch(/base64_image envelope/);
      expect(r.reason).toMatch(/vision-model sub-agents/);
      expect(r.reason).toMatch(/screenshot/);  // includes the field name
    }
  });

  it('skips base64_image even when a same-key text entry happens to exist', () => {
    // Defensive: don't accidentally route an image to a PDF-extracted-
    // text entry that shares the field name.
    const envelope = { kind: 'base64_image', data: '...', media_type: 'image/jpeg' };
    const r = resolveEnrichmentInput(envelope, 'doc', { doc: 'unrelated text' });
    expect(r.kind).toBe('skip');
  });

  // ── back-compat ─────────────────────────────────────────────────

  it('back-compat: an envelope with a numeric data field is treated as a plain object (not an envelope)', () => {
    // The isDocumentEntry-style guard requires `data: string`; defensive
    // against malformed envelopes that have the right kind but wrong
    // data type.
    const r = resolveEnrichmentInput(
      { kind: 'base64_pdf', data: 12345 },
      'document',
      {},
    );
    // Falls through to the "use as-is" branch — our guard is strict
    // about envelope shape so a malformed envelope doesn't silently
    // trigger the extracted-text path.
    expect(r.kind).toBe('use');
  });
});

// ── AUD-001: block-form sub-agent schema resolution ─────────────────────────
//
// Before the fix, `runEnrichment` resolved the sub-agent schema exclusively via
// `contractsMod[subIr.returnSchemaId]`. A block-form gen has `returnSchemaId:
// null` and carries the schema inline in `returnSchema` → the old code always
// fell into the "schema not found" branch, emitting EnrichError before the
// generate step ran. Fix: `subIr.returnSchema ?? contractsMod[subIr.returnSchemaId]`.
//
// AUD-F1: the probe .cmb.rb is written to an OS temp dir owned by this test,
// not to the live packages/cambium/app/gens/ tree. `runEnrichment` receives an
// injected `_findAgentFile` resolver that returns the temp path, so no file
// can leak into the committed tree or pollute a concurrent `cambium compile --write`.
describe('RED-419 AUD-001: block-form sub-agent schema resolution in runEnrichment', () => {
  const PROBE_GEN = `
class BlockEnrichProbe < GenModel
  model "omlx:stub"
  system "inline system"

  returns do
    field :summary, String
  end

  def summarize(input)
    generate "summarize" do
      with context: input
    end
  end
end
`;

  let tmpDir: string;
  let probeFile: string;

  beforeEach(() => {
    // AUD-F1: use an isolated temp dir — never the live app/gens/ directory.
    tmpDir = mkdtempSync(join(tmpdir(), 'cambium-aud001-'));
    probeFile = join(tmpDir, 'block_enrich_probe.cmb.rb');
    writeFileSync(probeFile, PROBE_GEN.trimStart());
    process.env.CAMBIUM_ALLOW_MOCK = '1';
  });
  afterEach(() => {
    delete process.env.CAMBIUM_ALLOW_MOCK;
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('block-form sub-agent resolves its inline schema — no EnrichError (AUD-001)', async () => {
    // mock generateText / extractJson that return a valid payload.
    // Note: ExtractJsonFn is synchronous (text: string) => any.
    const generateText = async () => ({ text: '{"summary":"ok"}', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const extractJson = (raw: string) => JSON.parse(raw);

    // AUD-F1: inject the resolver so runEnrichment uses the temp-dir path
    // rather than searching the live app/gens/ tree.
    const findProbe = (name: string) => name === 'BlockEnrichProbe' ? probeFile : null;

    const result = await runEnrichment(
      { field: 'report', agent: 'BlockEnrichProbe', method: 'summarize' },
      'some input text',
      {},                   // parentIr — unused in the schema-resolution path
      {},                   // contractsMod: intentionally empty (block form needs no entry)
      generateText as any,
      extractJson as any,
      findProbe,            // AUD-F1: injected resolver, keeps probe out of live gens dir
    );

    // The fix is correct when the result is ok (schema resolved and output validated).
    // Before the fix this was always EnrichError("Schema "null" not found…").
    expect(result.traceSteps.some((s: any) => s.type === 'EnrichError')).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ summary: expect.any(String) });
  });
});
