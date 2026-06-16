/**
 * AUD-PC1: `pass_context` must reach a `fan_out` nested inside a
 * `branch_on` body — permanent regression lock-in for the prior-operator
 * locator fix (PLAN-pass-context-fix-2026-06-15).
 *
 * Harness (DEC-006): drive `runPipelineFromIr` IN-PROCESS against a
 * `node:http` stub provider whose `summary` output echoes any `MARK-XXX`
 * sentinel found in the sub-gen's user prompt. This is NOT the `--mock`
 * CLI path — `mockGenerate` returns a fixed summary and cannot carry an
 * upstream-derived sentinel into a branch's observable output, which is
 * exactly the blind spot that let AUD-PC1 ship. The stub echo makes
 * "branch received the upstream context" directly observable: a branch's
 * `raw_preview` contains `MARK-UPSTREAM` iff `pass_context` delivered
 * `recon.summary` across the nesting boundary.
 *
 * The branch sub-gen (`Echo`) has NO `grounded_in`, so its compiled
 * `context.document` is "" — `MARK-UPSTREAM` can ONLY reach a branch via
 * `pass_context`, never from the branch's own primary document.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPipelineFromIr } from '../../cambium-runner/src/index.js';

const REPO_ROOT = process.cwd();
const COMPILE_RB = join(REPO_ROOT, 'ruby/cambium/compile.rb');

// AnalysisReport as a plain JSON Schema object (not a TypeBox import).
// The runner treats any `$id`-tagged object as a schema; TypeBox is the
// authoring ergonomic, not a runtime requirement — and a tmpdir contracts
// file can't resolve a bare `@sinclair/typebox` import (no local
// node_modules). Same approach as engine_mode_e2e.test.ts. Shape matches
// packages/cambium/src/contracts.ts § AnalysisReport.
const ANALYSIS_REPORT_CONTRACTS = `
export const AnalysisReport = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    metrics: {
      type: 'object',
      properties: {
        latency_ms_samples: { type: 'array', items: { type: 'number' } },
        avg_latency_ms: { type: 'number' },
      },
      additionalProperties: false,
    },
    key_facts: { type: 'array', items: { type: 'object' } },
  },
  required: ['summary', 'metrics', 'key_facts'],
  additionalProperties: false,
  $id: 'AnalysisReport',
};
`.trim() + '\n';

// ── Stub provider ─────────────────────────────────────────────────────
// OpenAI-compatible /v1/chat/completions. Scans the user message for
// MARK-XXX tokens and returns an AnalysisReport whose summary echoes the
// sorted set of marks it saw (or `echoed:none`).
let server: Server;
let scratch: string;
let savedBaseUrl: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let userContent = '';
      try {
        const parsed = JSON.parse(body || '{}');
        const userMsg = (parsed.messages ?? []).find((m: any) => m.role === 'user');
        userContent = typeof userMsg?.content === 'string' ? userMsg.content : '';
      } catch {
        userContent = '';
      }
      const marks = Array.from(new Set(userContent.match(/MARK-[A-Z0-9]+/g) ?? [])).sort();
      const summary = marks.length > 0 ? `echoed:${marks.join(',')}` : 'echoed:none';
      const report = { summary, metrics: { latency_ms_samples: [] }, key_facts: [] };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(report) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  savedBaseUrl = process.env.CAMBIUM_OMLX_BASEURL;
  process.env.CAMBIUM_OMLX_BASEURL = `http://127.0.0.1:${port}`;

  // ── Temp workspace ──────────────────────────────────────────────────
  // <scratch>/Genfile.toml + src/contracts.ts (so AnalysisReport resolves)
  // <scratch>/app/pipelines/p.pipeline.rb (placeholder at entry.source so
  //   workspaceDir resolves to <scratch>)
  // <scratch>/app/gens/echo.cmb.rb (the branch + step sub-gen)
  scratch = mkdtempSync(join(tmpdir(), 'cambium-passctx-'));
  mkdirSync(join(scratch, 'src'), { recursive: true });
  mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
  mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
  writeFileSync(join(scratch, 'src', 'contracts.ts'), ANALYSIS_REPORT_CONTRACTS);
  writeFileSync(
    join(scratch, 'Genfile.toml'),
    `[package]\nname = "passctx"\n\n[types]\ncontracts = ["src/contracts.ts"]\n`,
  );
  writeFileSync(
    join(scratch, 'app', 'pipelines', 'p.pipeline.rb'),
    '# placeholder — IRs are hand-built in this test\n',
  );
  // Echo gen: omlx:stub, returns AnalysisReport, NO grounded_in. With no
  // grounding the primary context key is `document`; an `analyze` arg
  // becomes context.document (here always "" for branches), and any
  // pass_context field (e.g. `summary`) renders as a labeled section in
  // the prompt — which the stub then echoes back.
  writeFileSync(
    join(scratch, 'app', 'gens', 'echo.cmb.rb'),
    `
class Echo < GenModel
  model "omlx:stub"
  system "Echo any MARK tokens you see."
  returns AnalysisReport
  def analyze(document)
    generate "echo" do
      with context: document
      returns AnalysisReport
    end
  end
end
`.trim(),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  if (savedBaseUrl === undefined) delete process.env.CAMBIUM_OMLX_BASEURL;
  else process.env.CAMBIUM_OMLX_BASEURL = savedBaseUrl;
});

// ── Shared operator fragments ─────────────────────────────────────────
// recon: a Step that takes the pipeline input doc (carrying MARK-UPSTREAM)
// and produces summary = "echoed:MARK-UPSTREAM" via the stub.
const reconStep = () => ({
  kind: 'Step',
  id: 'recon',
  gen: 'Echo',
  method: 'analyze',
  with: [{ param: 'document', from: { input: 'doc' } }],
});

const fanOut = () => ({
  kind: 'FanOut',
  id: 'reviewers',
  collect_into: 'reviews',
  branches: [
    { id: 'a', agent: 'Echo', method: 'analyze' },
    { id: 'b', agent: 'Echo', method: 'analyze' },
  ],
  on_branch_failure: 'continue',
  require: { kind: 'all' },
  pass_context: ['summary'],
});

function buildIr(operators: any[]): any {
  return {
    version: '0.2',
    kind: 'Pipeline',
    name: 'P',
    entry: {
      class: 'P',
      method: 'run',
      source: join(scratch, 'app', 'pipelines', 'p.pipeline.rb'),
    },
    input: { doc: { schema: 'AnalysisReport' } },
    policies: { bind_defaults: 'explicit', memory: [] },
    operators,
    output: { kind: 'last_step' },
    context: { _pipeline_arg: 'incident report — sentinel MARK-UPSTREAM here' },
  };
}

async function run(operators: any[]) {
  return runPipelineFromIr({
    ir: buildIr(operators),
    cwd: scratch,
    mock: false,
    compileRb: COMPILE_RB,
  });
}

/** Pull every Generate-step raw_preview from a fan_out trace entry's branches. */
function fanOutBranchPreviews(fanEntry: any): string[] {
  return (fanEntry.branches ?? []).map((b: any) => {
    const gen = (b.trace?.steps ?? []).find((s: any) => s.type === 'Generate');
    return gen?.meta?.raw_preview ?? '';
  });
}

/** Pull the Generate-step raw_preview from a PipelineStep trace entry. */
function stepPreview(stepEntry: any): string {
  const gen = (stepEntry.trace?.steps ?? []).find((s: any) => s.type === 'Generate');
  return gen?.meta?.raw_preview ?? '';
}

describe('AUD-PC1: pass_context across operator nesting boundaries', () => {
  // ── Test 1 — the missing case: fan_out nested in branch_on ──────────
  it('delivers pass_context into a fan_out nested inside a branch_on default block', async () => {
    // recon → branch_on(default → fan_out(pass_context :summary)). The
    // `on` value never matches the recon summary, so the default fires.
    const NESTED_OPS = [
      reconStep(),
      {
        kind: 'BranchOn',
        signal: { step: 'recon', field: 'summary' },
        branches: [{ values: ['__never_matches__'], operators: [] }],
        default: [fanOut()],
      },
    ];

    const result = await run(NESTED_OPS);
    expect(result.ok).toBe(true);

    // The fan_out lives under the branch_on entry's nested operators[].
    const branchOnEntry = result.trace.operators.find((o: any) => o.type === 'PipelineBranchOn');
    expect(branchOnEntry).toBeTruthy();
    expect(branchOnEntry.default_fired).toBe(true);
    const fanEntry = (branchOnEntry.operators ?? []).find((o: any) => o.type === 'PipelineFanOut');
    expect(fanEntry).toBeTruthy();
    expect(fanEntry.ok).toBe(true);

    // Every nested branch must have RECEIVED recon.summary via pass_context.
    const previews = fanOutBranchPreviews(fanEntry);
    expect(previews).toHaveLength(2);
    for (const p of previews) {
      expect(p).toContain('MARK-UPSTREAM');
    }
  }, 30_000);

  // ── Test 3a — lock-in: bind(:recon).field inside a branch_on body ───
  it('resolves bind(:prior).field for a step inside a branch_on body (shared stepResults)', async () => {
    // A step inside the default block reads recon.summary via `with`
    // bind — the shared stepResults path, NOT pass_context. This already
    // worked; the test fences it so the prevOutput change can't regress it.
    const BIND_OPS = [
      reconStep(),
      {
        kind: 'BranchOn',
        signal: { step: 'recon', field: 'summary' },
        branches: [{ values: ['__never_matches__'], operators: [] }],
        default: [
          {
            kind: 'Step',
            id: 'inner',
            gen: 'Echo',
            method: 'analyze',
            with: [{ param: 'document', from: { step: 'recon', field: 'summary' } }],
          },
        ],
      },
    ];

    const result = await run(BIND_OPS);
    expect(result.ok).toBe(true);

    const branchOnEntry = result.trace.operators.find((o: any) => o.type === 'PipelineBranchOn');
    const innerStep = (branchOnEntry.operators ?? []).find((o: any) => o.id === 'inner');
    expect(innerStep).toBeTruthy();
    expect(stepPreview(innerStep)).toContain('MARK-UPSTREAM');
  }, 30_000);

  // ── Test 3b — within-block update: fan_out's prior is an in-block sibling ──
  it('uses the in-block sibling output as a fan_out prior (not the operator before the branch_on)', async () => {
    // Inside the default block: step :pre → fan_out(pass_context :summary).
    // The fan_out's prior is :pre (the in-block sibling), exercising the
    // DEC-001(b) within-block prevOutput update — distinct from Test 1
    // where the fan_out is first-in-block (prior = the block seed).
    //
    // :pre reads MARK-PRE (a literal it carries forward); recon carries
    // MARK-UPSTREAM. If the fan_out (incorrectly) used recon as its prior,
    // the branches would echo MARK-UPSTREAM, not MARK-PRE. The assertion
    // that branches see MARK-PRE (and NOT MARK-UPSTREAM) pins the prior to
    // the in-block sibling.
    const SIBLING_OPS = [
      reconStep(),
      {
        kind: 'BranchOn',
        signal: { step: 'recon', field: 'summary' },
        branches: [{ values: ['__never_matches__'], operators: [] }],
        default: [
          {
            kind: 'Step',
            id: 'pre',
            gen: 'Echo',
            method: 'analyze',
            with: [{ param: 'document', from: { literal: 'pre-context sentinel MARK-PRE' } }],
          },
          fanOut(),
        ],
      },
    ];

    const result = await run(SIBLING_OPS);
    expect(result.ok).toBe(true);

    const branchOnEntry = result.trace.operators.find((o: any) => o.type === 'PipelineBranchOn');
    const fanEntry = (branchOnEntry.operators ?? []).find((o: any) => o.type === 'PipelineFanOut');
    expect(fanEntry).toBeTruthy();
    expect(fanEntry.ok).toBe(true);

    const previews = fanOutBranchPreviews(fanEntry);
    expect(previews).toHaveLength(2);
    for (const p of previews) {
      // Prior is the in-block sibling :pre, whose summary echoed MARK-PRE.
      expect(p).toContain('MARK-PRE');
      // And NOT the operator before the branch_on (recon → MARK-UPSTREAM).
      expect(p).not.toContain('MARK-UPSTREAM');
    }
  }, 30_000);
});

// ── Test 2 — strengthened top-level pass_context (positive control) ───
// Co-located here on the proven stub harness (per DEC-006 / Test 2 option
// (a)): the top-level fan_out branches must RECEIVE recon.summary, not
// merely report ok. This control proves the harness detects delivery when
// delivery happens — making Test 1's negative-before/positive-after
// trustworthy. (The old pipeline_runtime.test.ts:669 case is reduced to a
// thin structural check; this is the delivery assertion.)
describe('top-level pass_context delivery (positive control)', () => {
  it('delivers pass_context into a top-level fan_out', async () => {
    const TOPLEVEL_OPS = [reconStep(), fanOut()];

    const result = await run(TOPLEVEL_OPS);
    expect(result.ok).toBe(true);

    const fanEntry = result.trace.operators.find((o: any) => o.type === 'PipelineFanOut');
    expect(fanEntry).toBeTruthy();
    expect(fanEntry.ok).toBe(true);

    const previews = fanOutBranchPreviews(fanEntry);
    expect(previews).toHaveLength(2);
    for (const p of previews) {
      expect(p).toContain('MARK-UPSTREAM');
    }
  }, 30_000);
});
