/**
 * #220: `cambium run <file.cmb.rb> --method <m>` with no `--arg` used to
 * forge `--arg -` + stdin `'{}'`, clobbering a `grounded_in ..., from:`
 * bake-in with the literal 2-char string `"{}"`. The fix (STEP-001): the
 * CLI forwards an omitted `--arg` as an omission — no flag at all — and
 * `compile.rb` (the authority on gen-vs-pipeline, DEC-001), unmodified
 * on the gen path, lets the existing `from:` bake-in apply (RED-383) or
 * falls to `''` with no bake-in (DEC-004).
 *
 * Pipelines went through two designs before landing (DEC-006, Amendment
 * 2). DEC-005 tried putting the `'{}'` substitution in `parsePipelineInputs`
 * (the runtime binder), reasoning that it "only runs when a pipeline
 * actually executes" and so couldn't leak. AUD-001 proved that reasoning
 * wrong: `parsePipelineInputs` is also reached by `cambium serve`'s
 * `POST /v1/run`, `cambium replay`, and any library caller of
 * `runPipelineFromIr` — none of which asked for #220 — so the leak was
 * real, just not into the compiler. DEC-006 moves the substitution to
 * the one layer that actually saw the argv and can tell "the caller
 * supplied nothing" from "the caller supplied emptiness": the CLI. After
 * the IR was parsed, `cli/cambium.mjs` set `ir.context._pipeline_arg =
 * '{}'` directly, gated on `argOmitted && ir.kind === 'Pipeline'` — both
 * `parsePipelineInputs` and `compile.rb` ended this change byte-identical
 * to `origin/main`; the entire fix lived in `cli/cambium.mjs`. **#223
 * removed that substitution**; an omitted `--arg` against a pipeline
 * with declared `input` slots is now refused at the same gate (exit 2)
 * instead of substituted.
 *
 * Every assertion here is on the emitted IR (`runs/<id>/ir.json`), not on
 * run exit code — the pre-fix bug surfaces as a *grounding* failure, so
 * an exit-code check would pass for the wrong reason (STEP-003). The one
 * exception is the runner-level `describe` at the bottom (case 8/AUD-003),
 * which asserts on the bound slot directly — C-2 is only actually
 * observable there, not through the CLI (AUD-003).
 *
 * Harness mirrors `run_ir.test.ts`: `runCli` / `latestRunDir` helpers,
 * the scratch-workspace `beforeEach`/`afterEach` shape, and the
 * `GroundedGen` fixture (`grounded_in :report, from: "report.txt"`).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { runPipelineFromIr } from '../../cambium-runner/src/index.js';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

function runCli(args: string[], cwd: string, input?: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env },
    input,
  });
}

/** Most-recently-created `run_*` directory under `runsDir` — run ids are
 *  timestamp-prefixed, so lexicographic order is chronological order.
 *  Only safe for a workspace-private `runs/` dir (scratch `ws`) that no
 *  other concurrently-running test file writes into. */
function latestRunDir(runsDir: string): string {
  const entries = readdirSync(runsDir).filter((e) => e.startsWith('run_')).sort();
  expect(entries.length).toBeGreaterThan(0);
  return join(runsDir, entries[entries.length - 1]);
}

const GROUNDED_GEN = `
class GroundedGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :report, from: "report.txt"
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim();

// #169: `from:` ends in .md, so compile.rb infers `policies.grounding.format
// === "markdown"` when the bake-in applies (finding 2 — the second, unreported
// consequence of #220: the forged '{}' also suppressed format inference).
const NOTES_GEN = `
class NotesGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :notes, from: "notes.md"
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim();

// DEC-004: no from: bake-in, so `arg` (the raw CLI/compile-time input)
// flows straight into ir.context.document with nothing to fall back to.
const NO_BAKEIN_GEN = `
class NoBakeinGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :document
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim();

// AUD-002 shape (a): a binary `from:` + an explicit text `format:` is a
// DEC-011 contradiction — compile.rb resolves report.pdf to a base64_pdf
// envelope, and `format: :json` (a claim about a text view) contradicts
// it. Detection is by extension only (compile.rb:512-521), so the fixture
// bytes don't need to be a real PDF.
const BINARY_FORMAT_GEN = `
class BinaryFormatGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :report, from: "report.pdf", format: :json
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim();

// AUD-002 shape (b): a binary `from:` with no `format:` compiles fine —
// compile.rb emits the base64_image envelope unconditionally — but
// dispatch on a non-anthropic model fails the native-document gate
// (runner.ts), since "omlx:stub" cannot accept a native image/PDF.
const BINARY_NO_FORMAT_GEN = `
class BinaryNoFormatGen < GenModel
  model "omlx:stub"
  system "inline"
  grounded_in :report, from: "report.png"
  returns do
    field :summary, String
  end
  def analyze(input)
    generate "go" do
      with context: input
    end
  end
end
`.trim();

describe('#220: cambium run <file.cmb.rb> with omitted --arg', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'cambium-run-arg-omitted-'));
    mkdirSync(join(ws, 'app/gens'), { recursive: true });
    writeFileSync(join(ws, 'Genfile.toml'), `[package]\nname = "run-arg-omitted"\nversion = "0.0.0"\n`);

    // grounded_in's `from:` resolves relative paths from the GEN's own
    // directory, not the workspace root (see run_ir.test.ts).
    writeFileSync(join(ws, 'app/gens/report.txt'), 'baked report body');
    writeFileSync(join(ws, 'app/gens/grounded_gen.cmb.rb'), GROUNDED_GEN);

    // OQ-002: a local two-line fixture, not the golden corpus's
    // release_notes.md — that would make a corpus edit break this test
    // for an unrelated reason.
    writeFileSync(join(ws, 'app/gens/notes.md'), '# Notes\n\nSome markdown content.\n');
    writeFileSync(join(ws, 'app/gens/notes_gen.cmb.rb'), NOTES_GEN);

    writeFileSync(join(ws, 'app/gens/no_bakein_gen.cmb.rb'), NO_BAKEIN_GEN);

    // AUD-002 case 9: extension-only detection (compile.rb:512-521), so
    // placeholder bytes are enough — neither shape needs a real PDF/PNG.
    writeFileSync(join(ws, 'app/gens/report.pdf'), '%PDF-1.4 fake pdf bytes for extension detection');
    writeFileSync(join(ws, 'app/gens/binary_format_gen.cmb.rb'), BINARY_FORMAT_GEN);
    writeFileSync(join(ws, 'app/gens/report.png'), '\x89PNG fake png bytes for extension detection');
    writeFileSync(join(ws, 'app/gens/binary_no_format_gen.cmb.rb'), BINARY_NO_FORMAT_GEN);

    writeFileSync(join(ws, 'other.txt'), 'other file body');
  });
  afterEach(() => {
    if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  });

  it('the headline: omitted --arg lets the from: bake-in apply, not the forged "{}"', () => {
    const runRes = runCli(['run', 'app/gens/grounded_gen.cmb.rb', '--method', 'analyze', '--mock'], ws);
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.context.report).toBe('baked report body');
    expect(ir.context.report).not.toBe('{}'); // names the regression if it comes back
  });

  it('finding 2: the bake-in also restores the suppressed format: inference', () => {
    const runRes = runCli(['run', 'app/gens/notes_gen.cmb.rb', '--method', 'analyze', '--mock'], ws);
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.policies.grounding.format).toBe('markdown');
  });

  it('DEC-004: a gen with no from: bake-in converges from "{}" to "" (matches cambium compile)', () => {
    const runRes = runCli(['run', 'app/gens/no_bakein_gen.cmb.rb', '--method', 'analyze', '--mock'], ws);
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.context.document).toBe('');
  });

  it('#223 DEC-001: a single-slot pipeline with omitted --arg is refused, not run on a substituted "{}"', () => {
    // Amendment 3 (#223): supersedes DEC-006's assertion below. Amendment 2
    // had the CLI itself write `ir.context._pipeline_arg = '{}'` before
    // dispatch (cli/cambium.mjs, gated on argOmitted && ir.kind ===
    // 'Pipeline'), observable in runs/<id>/ir.json — itself a fix for the
    // dead DEC-005 design (Amendment 1), where the substitution happened
    // inside parsePipelineInputs and never reached the compiled IR at all.
    // #223 removes the substitution outright: a declared `input` slot is
    // mandatory by construction, so an omitted --arg is a caller error, not
    // a value to default. The CLI now refuses before loadRunner() and
    // writes no run directory at all — there is nothing to read back.
    const runRes = runCli(
      ['run', 'packages/cambium/app/pipelines/sample_pipeline.pipeline.rb', '--method', 'review', '--mock'],
      REPO_ROOT,
    );
    expect(runRes.status).toBe(2);
    expect(runRes.stderr).toMatch(/SamplePipeline/);
    expect(runRes.stderr).toMatch(/:document/);
    expect(runRes.stderr).not.toMatch(/dir=/); // no run directory was created
  });

  it('C-3: explicit --arg <file> still overrides the from: bake-in (RED-383)', () => {
    const runRes = runCli(
      ['run', 'app/gens/grounded_gen.cmb.rb', '--method', 'analyze', '--arg', 'other.txt', '--mock'],
      ws,
    );
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.context.report).toBe('other file body');
  });

  it('C-3: explicit --arg - still forwards real piped stdin (RED-397)', () => {
    const piped = 'piped over stdin';
    const runRes = runCli(
      ['run', 'app/gens/grounded_gen.cmb.rb', '--method', 'analyze', '--arg', '-', '--mock'],
      ws,
      piped,
    );
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0);

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.context.report).toBe(piped);
  });

  it("AUD-004: --arg '' is treated as omitted, never reaches Ruby's File.read('')", () => {
    // The plan forbids tightening `!arg` (STEP-001's argOmitted) to
    // `arg === null` — that would forward `--arg ''` to compile.rb, which
    // does `File.read('')` and raises Errno::ENOENT. This is the only
    // test enforcing that standing prohibition. AUD-004's correction:
    // the *predicate* (`!arg`) is unchanged, but the *behavior of the
    // branch it selects* is exactly what #220 rewrites, so `--arg ''`
    // moves from the forged '{}' to the bake-in, same as a bare omission
    // — it does not stay a fixed point across the fix.
    const runRes = runCli(
      ['run', 'app/gens/grounded_gen.cmb.rb', '--method', 'analyze', '--arg', '', '--mock'],
      ws,
    );
    expect(runRes.status, runRes.stderr + runRes.stdout).toBe(0); // not Errno::ENOENT

    const runDir = latestRunDir(join(ws, 'runs'));
    const ir = JSON.parse(readFileSync(join(runDir, 'ir.json'), 'utf8'));
    expect(ir.context.report).toBe('baked report body');
  });

  // AUD-002: unmasking `compile.rb`'s `arg_supplied` check (STEP-001)
  // affects all four of its consumers, not just the `from:` bake-in and
  // #169's format inference the plan's "finding 2" named. These two gen
  // shapes previously ran green under `cambium run` (the forged '{}' kept
  // `arg_supplied` permanently true) and now converge with what
  // `cambium compile` and `cambium run --ir` already did. Pinned here so
  // the convergence reads as deliberate, not as an accident — same
  // argument DEC-004 made for case 3.
  it('AUD-002 (a): from: <binary> + format: raises the DEC-011 contradiction at compile', () => {
    const runRes = runCli(
      ['run', 'app/gens/binary_format_gen.cmb.rb', '--method', 'analyze', '--mock'],
      ws,
    );
    expect(runRes.status).not.toBe(0);
    expect(runRes.stderr).toMatch(/applies to text sources/);
    expect(runRes.stderr).toMatch(/base64_pdf envelope/);
  });

  it('AUD-002 (b): from: <image> on a non-anthropic model fails the native-document gate', () => {
    const runRes = runCli(
      ['run', 'app/gens/binary_no_format_gen.cmb.rb', '--method', 'analyze', '--mock'],
      ws,
    );
    expect(runRes.status).not.toBe(0);
    expect(runRes.stderr).toMatch(/does not support native document input/);
  });
});

/**
 * Case 8 (AUD-003) + case 10 (AUD-001 regression guard), combined per the
 * plan: "Include the converse ... That pair is what would have caught
 * AUD-001." AUD-003 found that C-2 (the whole point of DEC-005/DEC-006)
 * was pinned by *nothing* — the CLI can only show `ir.context._pipeline_arg`,
 * which is `''` on both sides of any binder-level substitution, so no
 * CLI-driven test can ever see whether the substitution actually ran.
 * The only place it's observable is the bound slot itself, which requires
 * driving `runPipelineFromIr` directly — the same harness shape as
 * `pass_context_nested.test.ts` (hand-built IR, node:http stub provider,
 * no `--mock`, no CLI).
 *
 * Under DEC-006, `parsePipelineInputs` is byte-identical to `origin/main`
 * (no substitution at all) — these tests pin its existing, unmodified
 * contract directly: given the two `_pipeline_arg` values that matter
 * ('{}', which the CLI used to write into the IR before dispatch until
 * #223 removed the producer, and '', which is what every non-CLI caller —
 * serve, replay, a hand-built IR — supplies untouched), the single-slot branch binds the raw string
 * verbatim, the multi-slot branch JSON.parses it, and the zero-slot branch
 * ignores it. The converse case (empty `_pipeline_arg` binds '', not '{}')
 * is the AUD-001 regression guard: it is exactly what would have failed
 * had DEC-005's `parsePipelineInputs` substitution still been in place.
 */
describe('AUD-003/AUD-001: parsePipelineInputs binds what it is given, not a substitute', () => {
  const REPO_ROOT2 = process.cwd();
  const COMPILE_RB = join(REPO_ROOT2, 'ruby/cambium/compile.rb');
  let server: Server;
  let scratch: string;
  let captured: string[];

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
        captured.push(userContent);
        const report = { summary: 'ok', metrics: { latency_ms_samples: [] }, key_facts: [] };
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
    process.env.CAMBIUM_OMLX_BASEURL = `http://127.0.0.1:${port}`;

    scratch = mkdtempSync(join(tmpdir(), 'cambium-pipeline-arg-binding-'));
    mkdirSync(join(scratch, 'src'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'pipelines'), { recursive: true });
    mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
    writeFileSync(
      join(scratch, 'src', 'contracts.ts'),
      `
export const AnalysisReport = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    metrics: { type: 'object', properties: { latency_ms_samples: { type: 'array', items: { type: 'number' } } }, additionalProperties: false },
    key_facts: { type: 'array', items: { type: 'object' } },
  },
  required: ['summary', 'metrics', 'key_facts'],
  additionalProperties: false,
  $id: 'AnalysisReport',
};
`.trim() + '\n',
    );
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[package]\nname = "pipeline-arg-binding"\n\n[types]\ncontracts = ["src/contracts.ts"]\n`,
    );
    writeFileSync(
      join(scratch, 'app', 'pipelines', 'p.pipeline.rb'),
      '# placeholder — IRs are hand-built in this test\n',
    );
    // No grounded_in: the primary context key defaults to 'document',
    // so whatever the Step binds into the `document` param lands in
    // context.document and renders as the DOCUMENT: line in the prompt.
    writeFileSync(
      join(scratch, 'app', 'gens', 'echo.cmb.rb'),
      `
class Echo < GenModel
  model "omlx:stub"
  system "inline"
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
    delete process.env.CAMBIUM_OMLX_BASEURL;
  });

  beforeEach(() => {
    captured = [];
  });

  function buildIr(inputSlots: Record<string, { schema: string }>, pipelineArg: string, stepWith: any[]): any {
    return {
      version: '0.2',
      kind: 'Pipeline',
      name: 'P',
      entry: { class: 'P', method: 'run', source: join(scratch, 'app', 'pipelines', 'p.pipeline.rb') },
      input: inputSlots,
      policies: { bind_defaults: 'explicit', memory: [] },
      operators: [{ kind: 'Step', id: 'echo', gen: 'Echo', method: 'analyze', with: stepWith }],
      output: { kind: 'last_step' },
      context: { _pipeline_arg: pipelineArg },
    };
  }

  function runIr(ir: any) {
    return runPipelineFromIr({ ir, cwd: scratch, mock: false, compileRb: COMPILE_RB });
  }

  /** The value bound to the sub-gen's `document` param, read back from
   *  the outgoing prompt (`DOCUMENT:\n<value>`, step-handlers.ts:266-268). */
  function documentLine(userContent: string): string {
    const m = userContent.match(/DOCUMENT:\n([^\n]*)/);
    expect(m).toBeTruthy();
    return m![1];
  }

  it("binds a '{}' _pipeline_arg (a binder property; #223 removed the CLI producer that used to write this) verbatim into a single slot", async () => {
    const ir = buildIr({ doc: { schema: 'AnalysisReport' } }, '{}', [
      { param: 'document', from: { input: 'doc' } },
    ]);
    const result = await runIr(ir);
    expect(result.ok).toBe(true);
    expect(documentLine(captured.at(-1)!)).toBe('{}');
  });

  it("AUD-001 regression guard (case 10): an empty '' _pipeline_arg (serve's shape, no CLI) binds '', NOT '{}'", async () => {
    const ir = buildIr({ doc: { schema: 'AnalysisReport' } }, '', [
      { param: 'document', from: { input: 'doc' } },
    ]);
    const result = await runIr(ir);
    expect(result.ok).toBe(true);
    const doc = documentLine(captured.at(-1)!);
    expect(doc).toBe('');
    expect(doc).not.toBe('{}');
  });

  // #226 (was: "JSON.parses cleanly — every declared slot undefined, no
  // throw"). #223 pinned that as the STATUS QUO, not as desired behavior: it
  // was scoped to the omitted `--arg`, and this gap needs a supplied one, so
  // fixing it here would have been smuggling. #226 is that decision, and it
  // inverts this pin — a parseable object that leaves declared slots unbound
  // now fails closed, naming them.
  it("a '{}' _pipeline_arg on a multi-slot pipeline now fails closed, naming every unbound slot (#226)", async () => {
    const ir = buildIr(
      { a: { schema: 'AnalysisReport' }, b: { schema: 'AnalysisReport' } },
      '{}',
      [{ param: 'document', from: { input: 'a' } }],
    );
    await expect(runIr(ir)).rejects.toThrow(/missing 2 of 2 declared input slot\(s\): a, b/);
  });

  it("an empty '' _pipeline_arg on a multi-slot pipeline still throws the clear JSON-object error (fail-closed preserved for non-CLI callers)", async () => {
    const ir = buildIr(
      { a: { schema: 'AnalysisReport' }, b: { schema: 'AnalysisReport' } },
      '',
      [{ param: 'document', from: { input: 'a' } }],
    );
    await expect(runIr(ir)).rejects.toThrow(/must be a JSON object/);
  });

  it('a zero-slot pipeline ignores _pipeline_arg entirely, regardless of value', async () => {
    const withLiteral = [{ param: 'document', from: { literal: '' } }];
    await expect(runIr(buildIr({}, '{}', withLiteral))).resolves.toMatchObject({ ok: true });
    await expect(runIr(buildIr({}, '', withLiteral))).resolves.toMatchObject({ ok: true });
  });

  /**
   * #226 — partial multi-slot binding.
   *
   * These drive `runPipelineFromIr` directly, with no CLI in the picture, on
   * purpose: the gap #226 closes lives in the BINDER, so unlike #223 (which
   * was CLI-only by design) it reaches `cambium serve`, `cambium replay`, and
   * any library caller. This harness is that shape.
   */
  describe('#226: a parseable object must bind every declared slot', () => {
    const twoSlots = { a: { schema: 'AnalysisReport' }, b: { schema: 'AnalysisReport' } };
    const bindA = [{ param: 'document', from: { input: 'a' } }];

    it('names only the MISSING slot, not every declared one', async () => {
      const ir = buildIr(twoSlots, JSON.stringify({ a: 'supplied' }), bindA);
      // The distinction the acceptance criteria asked for: `a` was supplied
      // and must not appear in the missing list.
      await expect(runIr(ir)).rejects.toThrow(/missing 1 of 2 declared input slot\(s\): b\./);
    });

    it('a complete object still binds and runs', async () => {
      const ir = buildIr(twoSlots, JSON.stringify({ a: 'one', b: 'two' }), bindA);
      await expect(runIr(ir)).resolves.toMatchObject({ ok: true });
    });

    it('an explicit null is supplied, not missing — the schema judges it, not the binder', async () => {
      const ir = buildIr(twoSlots, JSON.stringify({ a: 'one', b: null }), bindA);
      await expect(runIr(ir)).resolves.toMatchObject({ ok: true });
    });

    it('own-property only: `input :constructor` reads as missing, not as Object.prototype.constructor', async () => {
      // `NAME_RE` in ruby/cambium/pipeline.rb is /\A[a-z][a-z0-9_]*\z/, which
      // permits `constructor` — so this is a legal declaration, not a
      // contrived one. A plain `parsed[slot]` read binds a function here and
      // reports nothing missing: fail-open through the documented DSL.
      const ir = buildIr(
        { a: { schema: 'AnalysisReport' }, constructor: { schema: 'AnalysisReport' } },
        JSON.stringify({ a: 'supplied' }),
        bindA,
      );
      await expect(runIr(ir)).rejects.toThrow(/missing 1 of 2 declared input slot\(s\): constructor\./);
    });

    it('single-slot and zero-slot pipelines are untouched by the new gate', async () => {
      // Both return before the multi-slot branch; #226 must not reach them.
      const one = buildIr({ a: { schema: 'AnalysisReport' } }, '', bindA);
      await expect(runIr(one)).resolves.toMatchObject({ ok: true });
      const none = buildIr({}, '{"a":1}', [{ param: 'document', from: { literal: '' } }]);
      await expect(runIr(none)).resolves.toMatchObject({ ok: true });
    });

    it('the pre-existing non-object error is unchanged (not swallowed by the new one)', async () => {
      const arr = buildIr(twoSlots, '[1,2]', bindA);
      await expect(runIr(arr)).rejects.toThrow(/must be a JSON object/);
      const bad = buildIr(twoSlots, 'not json', bindA);
      await expect(runIr(bad)).rejects.toThrow(/must be a JSON object/);
    });
  });
});
