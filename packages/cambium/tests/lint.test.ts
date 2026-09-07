/**
 * RED-284: `cambium lint` coverage for RED-212/214/215/275/237/239 surfaces.
 *
 * Each test builds a minimal workspace in a temp dir — just enough for
 * lint to find it (workspace Genfile pointing at a package with the
 * surface-under-test populated) — and spawns the CLI to check the
 * output. The body validations intentionally don't do deep semantic
 * checks; lint's job is to catch filename typos and trivial structural
 * errors fast, with the Ruby compiler being the authoritative check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

function runLint(cwd: string): { status: number | null; output: string } {
  const result = spawnSync('node', [CLI, 'lint'], { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

function setupMinimalWorkspace(scratch: string) {
  // Top-level workspace Genfile.
  writeFileSync(
    join(scratch, 'Genfile.toml'),
    `[workspace]\nmembers = ["packages/*"]\n`,
  );

  // One package — minimum fields for lint to walk it.
  const pkg = join(scratch, 'packages', 'testpkg');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'Genfile.toml'),
    `[package]
name = "testpkg"
version = "0.1.0"

[types]
contracts = ["src/contracts.ts"]

[tests]
smoke = "tests/smoke.test.ts"
`,
  );

  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src/contracts.ts'), '// empty\n');
  mkdirSync(join(pkg, 'tests'), { recursive: true });
  writeFileSync(join(pkg, 'tests/smoke.test.ts'), '// placeholder\n');

  return pkg;
}

describe('cambium lint — RED-284 coverage for new surfaces', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('passes on a well-formed action', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/actions'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/actions/notify.action.json'),
      JSON.stringify({
        name: 'notify',
        description: 'test',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permissions: { pure: true },
      }),
    );
    writeFileSync(join(pkg, 'app/actions/notify.action.ts'), 'export async function execute() {}\n');

    const { output } = runLint(scratch);
    expect(output).toMatch(/action definition: notify\.action\.json/);
    expect(output).toMatch(/implementation: notify\.action\.ts/);
  });

  it('warns on missing action implementation', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/actions'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/actions/orphan.action.json'),
      JSON.stringify({ name: 'orphan', inputSchema: {}, outputSchema: {} }),
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/no implementation found for action "orphan"/);
  });

  it('fails on a policy pack with an invalid basename', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/policies'), { recursive: true });
    writeFileSync(join(pkg, 'app/policies/BadCase.policy.rb'), '# empty\n');

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/policy pack name "BadCase".*must match/);
  });

  it('fails on a memory pool with an invalid basename', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/memory_pools'), { recursive: true });
    writeFileSync(join(pkg, 'app/memory_pools/has-hyphen.pool.rb'), '# empty\n');

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/memory pool name "has-hyphen".*must match/);
  });

  it('passes a corrector whose export name matches the basename', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/correctors'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/correctors/regex_check.corrector.ts'),
      `export const regex_check = (data, _ctx) => ({ corrected: false, output: data, issues: [] });\n`,
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/corrector: regex_check\.corrector\.ts/);
    expect(output).toMatch(/exports "regex_check" \(matches basename\)/);
  });

  it('fails a corrector whose export does not match the basename', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/correctors'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/correctors/expected_name.corrector.ts'),
      `export const wrong_name = (data) => ({ corrected: false, output: data, issues: [] });\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/must export "expected_name" matching the basename/);
  });

  it('fails a corrector with an invalid basename', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/correctors'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/correctors/BadCase.corrector.ts'),
      `export const BadCase = () => {};\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/corrector name "BadCase".*must match/);
  });

  it('passes a well-formed custom provider (RED-393)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/providers'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/providers/bedrock.ts'),
      `import { openaiCompatible } from '@redwood-labs/cambium-runner';\n`
        + `export default openaiCompatible({ name: 'bedrock', baseUrl: () => 'https://x', auth: () => undefined });\n`,
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/provider: bedrock\.ts/);
  });

  it('fails a provider whose name field does not match the basename (RED-393)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/providers'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/providers/bedrock.ts'),
      `export default { name: 'wrong', generateText() {}, generateWithTools() {} };\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/declares name 'wrong' but the filename requires 'bedrock'/);
  });

  it('fails a provider with no export default (RED-393)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/providers'), { recursive: true });
    writeFileSync(join(pkg, 'app/providers/bedrock.ts'), `export const x = 1;\n`);

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/must `export default` a CambiumProvider/);
  });

  it('fails a provider with an invalid basename (RED-393)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/providers'), { recursive: true });
    writeFileSync(join(pkg, 'app/providers/BadCase.ts'), `export default {};\n`);

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/provider file name "BadCase".*must match/);
  });

  it('passes known config files and warns on unknown ones', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/config'), { recursive: true });
    writeFileSync(join(pkg, 'app/config/models.rb'), '# ok\n');
    writeFileSync(join(pkg, 'app/config/memory_policy.rb'), '# ok\n');
    writeFileSync(join(pkg, 'app/config/typo.rb'), '# unexpected\n');

    const { output } = runLint(scratch);
    expect(output).toMatch(/config: models\.rb/);
    expect(output).toMatch(/config: memory_policy\.rb/);
    expect(output).toMatch(/unknown config file: typo\.rb/);
  });

  it('stays silent about new surfaces when the dirs are absent (regression)', () => {
    setupMinimalWorkspace(scratch);
    const { status, output } = runLint(scratch);
    expect(output).not.toMatch(/action definition/);
    expect(output).not.toMatch(/policy pack/);
    expect(output).not.toMatch(/memory pool/);
    expect(output).not.toMatch(/corrector:/);
    expect(output).not.toMatch(/config:/);
    // A minimal workspace with just the contracts file + empty smoke test
    // still warns about missing exports.gens, but that's expected.
    expect(status).toBe(0);
  });

  // ── RED-210: app-mode `returns <Schema>` check ──────────────────────
  //
  // Symbol-form `returns` must resolve to an export of the Genfile's
  // [types] contracts. Block-form `returns do … end` (RED-419) compiles
  // the schema inline and never touches contracts.ts — lint must skip
  // it, and lowercase prose in comments ("…returns a structured…") must
  // not trip the check (issues #167 / #160).

  it('app mode: skips block-form `returns do … end` (issue #167)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/block_gen.cmb.rb'),
      `class BlockGen < GenModel\n`
        + `  model "omlx:stub"\n`
        + `  # Analyzes a document and returns a structured stock analysis report.\n`
        + `  returns do\n`
        + `    field :summary, String\n`
        + `  end\n`
        + `end\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/not exported from src\/contracts\.ts/);
  });

  it('app mode: passes symbol-form returns when the export exists', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(join(pkg, 'src/contracts.ts'), `export const BlockReport = Type.Object({});\n`);
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/sym_gen.cmb.rb'),
      `class SymGen < GenModel\n  model "omlx:stub"\n  returns BlockReport\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/sym_gen\.cmb\.rb: returns BlockReport \(found in src\/contracts\.ts\)/);
  });

  it('app mode: fails symbol-form returns :<typo> with a suggestion', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(join(pkg, 'src/contracts.ts'), `export const BlockReport = Type.Object({});\n`);
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/typo_gen.cmb.rb'),
      `class TypoGen < GenModel\n  model "omlx:stub"\n  returns :Blockreport\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/returns Blockreport — not exported from src\/contracts\.ts/);
    expect(output).toMatch(/Did you mean 'BlockReport'\?/);
  });

  // ── issue #211 round 2 (AUD-211-01): the unanchored `returns` regex
  // grabs prose out of a live (non-comment) string, not just comments.
  // A gen using RED-419 block-form `returns do … end` with a `system`
  // string that happens to contain "returns <Capitalized word>" used to
  // hard-fail app-mode lint on a workspace that compiles cleanly.

  it('app mode: does not fail on `returns` inside a live `system` string when using block-form `returns do … end`', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/prose_gen.cmb.rb'),
      `class ProseGen < GenModel\n`
        + `  model "omlx:stub"\n`
        + `  system "You are an agent that returns Markdown prose."\n`
        + `  returns do\n`
        + `    field :summary, String\n`
        + `  end\n`
        + `  def analyze(x)\n    generate "x"\n  end\n`
        + `end\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/returns Markdown/);
    expect(output).not.toMatch(/not exported from src\/contracts\.ts/);
  });

  // ── RED-286: flat [package] layout (external apps) ──
  //
  // A curator-style project has a single top-level Genfile.toml with
  // [package] at the root and flat app/{gens,tools,...}/ directories —
  // NO [workspace] members, no packages/cambium/ subdir. runLint must
  // lint the cwd as a single package instead of bailing with "no
  // members."

  function setupFlatPackage(dir: string) {
    writeFileSync(
      join(dir, 'Genfile.toml'),
      `[package]
name = "curator_dogfood"
version = "0.1.0"

[types]
contracts = ["src/contracts.ts"]

[tests]
smoke = "tests/smoke.test.ts"
`,
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/contracts.ts'), '// empty\n');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests/smoke.test.ts'), '// placeholder\n');
  }

  it('flat [package] layout: lints cwd directly, no "no members" bail', () => {
    setupFlatPackage(scratch);
    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/no \[workspace\] members/);
    expect(output).toMatch(/package\.name = "curator_dogfood"/);
  });

  it('flat [package] layout: lints app/correctors/ at the flat path', () => {
    setupFlatPackage(scratch);
    mkdirSync(join(scratch, 'app/correctors'), { recursive: true });
    writeFileSync(
      join(scratch, 'app/correctors/regex_check.corrector.ts'),
      `export const regex_check = (data, _ctx) => ({ corrected: false, output: data, issues: [] });\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/corrector: regex_check\.corrector\.ts/);
  });

  it('flat [package] layout: surfaces the same validation errors as workspace layout', () => {
    setupFlatPackage(scratch);
    mkdirSync(join(scratch, 'app/policies'), { recursive: true });
    writeFileSync(join(scratch, 'app/policies/BadCase.policy.rb'), '# empty\n');

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/policy pack name "BadCase".*must match/);
  });

  // ── RED-289: engine-mode lint ────────────────────────────────────────
  //
  // An engine folder is self-contained: surfaces are siblings of the
  // gen, not under app/<type>/. Lint detects the sentinel and walks
  // siblings with the same regex + JSON checks app-mode uses.

  function setupEngineFolder(dir: string) {
    writeFileSync(
      join(dir, 'cambium.engine.json'),
      JSON.stringify({ name: 'test_engine', version: '0.1.0' }),
    );
    writeFileSync(
      join(dir, 'schemas.ts'),
      `export const TestReport = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $id: 'TestReport' };\n`,
    );
    writeFileSync(
      join(dir, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  returns TestReport\n  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );
    writeFileSync(join(dir, 'test_gen.system.md'), 'You are a test agent.\n');
  }

  it('engine mode: passes on a minimal well-formed engine folder', () => {
    setupEngineFolder(scratch);
    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/Engine: /);
    expect(output).toMatch(/cambium\.engine\.json\.name = "test_engine"/);
    expect(output).toMatch(/schemas\.ts/);
    expect(output).toMatch(/returns TestReport \(found in schemas\.ts\)/);
    expect(output).toMatch(/system :test_gen → test_gen\.system\.md/);
  });

  it('engine mode: fails on returns <typo> with a schemas.ts suggestion', () => {
    setupEngineFolder(scratch);
    // Rewrite the gen to use a typo'd schema name.
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  returns TestRepor\n  def analyze(x)\n    generate "x" do\n      returns TestRepor\n    end\n  end\nend\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/returns TestRepor — not exported from schemas\.ts/);
  });

  it('engine mode: fails on a system :name with no sibling system.md', () => {
    setupEngineFolder(scratch);
    rmSync(join(scratch, 'test_gen.system.md'));
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/system :test_gen — no sibling test_gen\.system\.md/);
  });

  it('engine mode: validates sibling *.tool.json shape + implementation pairing', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'calc.tool.json'),
      JSON.stringify({
        name: 'calc', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      }),
    );
    // Deliberately skip the .tool.ts sibling — expect a warning.
    const { status, output } = runLint(scratch);
    expect(status).toBe(0); // warning, not fail
    expect(output).toMatch(/tool: calc\.tool\.json/);
    expect(output).toMatch(/no implementation for tool "calc"/);
  });

  it('engine mode: fails on a corrector whose export does not match its basename', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'check.corrector.ts'),
      `export const wrong_name = (data) => ({ corrected: false, output: data, issues: [] });\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/check\.corrector\.ts: must export "check"/);
  });

  it('engine mode: fails on `security :pack` with no sibling policy.rb', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  security :missing_pack\n  returns TestReport\n  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/security :missing_pack — no sibling missing_pack\.policy\.rb/);
  });

  it('engine mode: fails on memory scope :pool_name with no sibling pool.rb', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  memory :facts, scope: :missing_pool, top_k: 5\n  returns TestReport\n  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/memory scope :missing_pool — no sibling missing_pool\.pool\.rb/);
  });

  it('engine mode: reserved scope names (:session, :global) do not trigger pool lookup', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  memory :log, strategy: :log, scope: :global\n  returns TestReport\n  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/no sibling global\.pool\.rb/);
  });

  it('engine mode: walks up to find the sentinel from a nested cwd', () => {
    setupEngineFolder(scratch);
    const deep = join(scratch, 'nested');
    mkdirSync(deep, { recursive: true });
    const { status, output } = runLint(deep);
    expect(status).toBe(0);
    expect(output).toMatch(/Engine: /);
  });

  it('engine mode: warns about engine folders containing more than one .cmb.rb', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'second.cmb.rb'),
      `class Second < GenModel\n  model "omlx:stub"\n  returns TestReport\n  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );
    const { output } = runLint(scratch);
    expect(output).toMatch(/has 2 gens/);
  });

  // ── issue #211: `returns <Schema>` guard must not swallow the
  // "schemas.ts exists but the single-pattern `export const` scan
  // recognized none of its exports" case. Widening the scan itself is
  // issue #210's territory (out of scope here); this only closes the
  // silent-pass hole the too-broad `availableSchemas.size > 0` guard
  // opened.

  it('engine mode: warns (does not silently pass) when schemas.ts uses an `export { X }` idiom the export-const scan cannot see', () => {
    setupEngineFolder(scratch);
    // `const X = ...; export { X }` — the single `/^\s*export\s+const\s+.../`
    // pattern at cli/lint.mjs finds zero matches even though TestReport is
    // genuinely exported.
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `const TestReport = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $id: 'TestReport' };\n`
        + `export { TestReport };\n`,
    );

    const { output } = runLint(scratch);
    expect(output).not.toMatch(/✓ All checks passed\./);
    expect(output).toMatch(
      /returns TestReport — schemas\.ts has no `export const` declarations lint recognizes, could not validate this reference/,
    );
    // Must not claim the schema is missing — it IS exported, just via an
    // idiom the scan doesn't recognize (the audit's "not exported"
    // misdirection this issue calls out).
    expect(output).not.toMatch(/not exported from schemas\.ts/);
  });

  it('engine mode: populated export-const scan still passes returns <Schema> (no regression)', () => {
    setupEngineFolder(scratch); // schemas.ts uses plain `export const TestReport = ...`
    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/returns TestReport \(found in schemas\.ts\)/);
  });

  it('engine mode: populated export-const scan still fails returns <typo> (no regression, RED-210 typo check)', () => {
    setupEngineFolder(scratch);
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  returns TestRepor\n  def analyze(x)\n    generate "x" do\n      returns TestRepor\n    end\n  end\nend\n`,
    );
    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/returns TestRepor — not exported from schemas\.ts/);
  });

  // ── issue #211 round 2 (AUD-211-01): the round-1 warn path was
  // reachable off the same unanchored regex — a gen using block-form
  // `returns do … end` with a `system` string containing "returns
  // <Capitalized word>" lost its all-clear on a workspace that compiles.

  it('engine mode: does not warn on `returns` inside a live `system` string when using block-form `returns do … end`', () => {
    setupEngineFolder(scratch);
    // schemas.ts uses the `export { X }` idiom the export-const scan
    // can't see (round 1's own repro shape) — the branch the unanchored
    // regex used to reach.
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `const TestReport = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $id: 'TestReport' };\n`
        + `export { TestReport };\n`,
    );
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n`
        + `  model "omlx:stub"\n`
        + `  system "You are an agent that returns Markdown prose."\n`
        + `  returns do\n`
        + `    field :summary, String\n`
        + `  end\n`
        + `  def analyze(x)\n    generate "x"\n  end\n`
        + `end\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/✓ All checks passed\./);
    expect(output).not.toMatch(/returns Markdown/);
  });
});

// ── RED-218 / issue #168: framework-builtin tool resolution in app mode ──
//
// `cambium lint` warns "no tool definition" for every `uses :<name>` whose
// `.tool.json` isn't under app/tools/, but the runtime resolves framework
// builtins (web_search, calculator, read_file, execute_code, web_extract)
// from packages/cambium-runner/src/builtin-tools/ — not a local def. The
// whitelist at cli/lint.mjs::BUILTIN_TOOL_NAMES is lint's source of truth;
// this suite both proves the fix and guards against drift: a future builtin
// added to the runner catalog but missing from that set must fail here.
function setupAppWithUses(scratch: string, usesLine: string) {
  const pkg = setupMinimalWorkspace(scratch);
  mkdirSync(join(pkg, 'app/gens'), { recursive: true });
  writeFileSync(
    join(pkg, 'app/gens/demo.cmb.rb'),
    `class Demo < GenModel\n  model :default\n  system :demo\n${usesLine}\n`
      + `  def analyze(x)\n    generate "x" do\n    end\n  end\nend\n`,
  );
  return pkg;
}

// Names of the framework builtins as the runtime actually resolves them —
// parsed from the live catalog, not copied here. This is the drift guard:
// if someone adds a builtin to the runner dir and forgets lint's whitelist,
// this list changes and every case below re-validates against it.
function runtimeBuiltinNames(): string[] {
  const dir = join(REPO_ROOT, 'packages', 'cambium-runner', 'src', 'builtin-tools');
  return readdirSync(dir)
    .filter(f => f.endsWith('.tool.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')).name);
}

describe('cambium lint — RED-218 framework-builtin tool resolution (app mode)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-builtins-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('does NOT warn for every framework builtin in the live catalog', () => {
    const builtins = runtimeBuiltinNames();
    const usesLine = `  uses :${builtins.join(', ')}`;
    setupAppWithUses(scratch, usesLine);

    const { status, output } = runLint(scratch);
    // Every builtin is a legitimate ref → no "no tool definition" warnings.
    expect(output).not.toMatch(/no tool definition/);
    expect(status).toBe(0);
  });

  it('still warns for a genuinely-missing tool (only builtins are whitelisted)', () => {
    setupAppWithUses(scratch, '  uses :not_a_real_tool');

    const { status, output } = runLint(scratch);
    // The real bug class — unknown tools must still be caught.
    expect(output).toMatch(/uses :not_a_real_tool — no tool definition/);
    // Framing note: lint explicitly says builtins are OK here, proving the
    // whitelist is selective, not blanket.
    expect(output).toMatch(/\(ok if framework builtin\)/);
  });

  it('drift guard: every live runtime builtin name passes without a warning', () => {
    const builtins = runtimeBuiltinNames();
    // Sanity: the catalog is non-empty and stable-shaped.
    expect(builtins.length).toBeGreaterThan(0);

    setupAppWithUses(scratch, `  uses :${builtins.join(', ')}`);
    const { output } = runLint(scratch);

    // If any runtime builtin is missing from lint's whitelist this fires —
    // exactly the Q4 concern (lint blind to other resolved tool sources).
    expect(output).not.toMatch(/no tool definition/);
  });
});

// ── issue #158: lint must not match commented-out DSL ────────────────
//
// `cli/lint.mjs`'s `uses`/`returns` regex scans matched anywhere in the
// file body, not just live code, so the scaffolders' own worked-example
// comments (`# uses :web_search, :calculator`, prose mentioning `returns
// :SchemaName`) tripped the same checks meant for live declarations.
// Whole-line comment stripping fixes both the app-mode and engine-mode
// scanners.
describe('cambium lint — issue #158 comment-stripped DSL scans', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-comments-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('app mode: does not warn on a commented-out `# uses :<tool>`', () => {
    setupAppWithUses(scratch, '  # uses :not_a_real_tool');

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/uses :not_a_real_tool/);
  });

  it('app mode: does not fail `returns` on a comment mentioning `returns :SchemaName`', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/commented_gen.cmb.rb'),
      `class CommentedGen < GenModel\n`
        + `  model "omlx:stub"\n`
        + `  # For anything richer, use \`returns :SchemaName\` and\n`
        + `  # \`cambium new schema\` (the hand-written escape hatch).\n`
        + `  returns do\n`
        + `    field :summary, String\n`
        + `  end\n`
        + `end\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/returns SchemaName/);
    expect(output).not.toMatch(/not exported from src\/contracts\.ts/);
  });

  it('engine mode: does not warn on commented-out `# uses` / `# corrects` lines', () => {
    // Inlined engine-folder setup (the RED-289 `setupEngineFolder` helper
    // is scoped to its own describe block above) with the scaffold's own
    // commented-out `# uses` / `# corrects` examples added.
    writeFileSync(
      join(scratch, 'cambium.engine.json'),
      JSON.stringify({ name: 'test_engine', version: '0.1.0' }),
    );
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `export const TestReport = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $id: 'TestReport' };\n`,
    );
    writeFileSync(join(scratch, 'test_gen.system.md'), 'You are a test agent.\n');
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n  returns TestReport\n`
        + `  # uses :web_search, :calculator\n`
        + `  # corrects :math\n`
        + `  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/uses :web_search/);
    expect(output).not.toMatch(/corrects :math/);
  });
});

// ── issue #217 Phase A — mechanical fixes from AUDIT-211's class sweep ──
//
// Each test below reproduces a fixture from records/AUDIT-211-classsweep
// -2026-09-03.md § Repro fixtures verbatim (or as close as a vitest
// harness allows) and pins the fixed behavior. All were verified red
// against the pre-STEP-001..005 code and green after (see
// records/CHANGE-217-phaseA-2026-09-03.md for the stash/pop evidence).
describe('cambium lint — issue #217 Phase A (lint check-outcome fixes)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-217-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  // CS-01 — the hand-rolled TOML parser collapsed a multi-line `members`
  // array to `[]` (truthy), so the workspace walk linted zero packages.
  it('CS-01: multi-line `members` array now lints its packages instead of zero', () => {
    setupMinimalWorkspace(scratch);
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = [\n  "packages/*",\n]\n`,
    );

    const { status, output } = runLint(scratch);
    expect(output).toMatch(/Package: testpkg/);
    expect(output).toMatch(/package\.name = "testpkg"/);
    expect(status).toBe(0);
  });

  // CS-02 is OPEN, not closed by Phase A (AUD-217-03). The member walk
  // re-implemented `expandMembers`'s glob logic inline, with no return
  // value a test could inspect; exporting `expandMembers` makes its
  // empty result directly assertable, which is a *precondition* for
  // fixing CS-02 — not the fix. `members = ["apps/*"]` (no apps/ dir) and
  // a glob matching a Genfile-less directory both still print `✓ All
  // checks passed.` / exit 0 with zero packages linted, here and at
  // 0a4f318. The actual remedy is Phase B's `checked === 0` guard
  // (DEC-006). This test is retitled from "CS-02: ..." to what it
  // actually proves — read it as exactly that, not a CS-02 regression
  // test.
  it('expandMembers is exported and its empty result is directly assertable', async () => {
    const shape = await import('../../../cli/workspace-shape.mjs');
    expect(typeof shape.expandMembers).toBe('function');

    // (a) glob matches nothing — no `apps/` dir under this root.
    expect(shape.expandMembers(scratch, ['apps/*'])).toEqual([]);

    // (b) glob matches a directory with no Genfile.toml.
    mkdirSync(join(scratch, 'packages', 'nogenfile'), { recursive: true });
    expect(shape.expandMembers(scratch, ['packages/*'])).toEqual([]);
  });

  // CS-03 — `[types] contracts` truthy-but-empty in two shapes.
  it('CS-03: multi-line `contracts` array now parses instead of collapsing to [] (array form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = [\n  "src/contracts.ts",\n]\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/contracts: src\/contracts\.ts/);
  });

  it('CS-03: `contracts = []` explicit empty array now fails instead of being silently accepted (empty form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = []\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/types\.contracts not declared/);
  });

  // CS-04 — `[exports.gens]` truthy-but-empty in two shapes.
  it('CS-04: dashed/quoted `[exports.gens]` key is now parsed instead of silently dropped (key form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts"]\n\n`
        + `[exports.gens]\n"My-Gen" = "app/gens/missing.cmb.rb"\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/exports\.gens\.My-Gen: app\/gens\/missing\.cmb\.rb — not found/);
  });

  it('CS-04: empty `[exports.gens]` section now warns instead of being silently skipped (empty form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts"]\n\n`
        + `[exports.gens]\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/No exports\.gens declared/);
  });

  // CS-05 — `[tests]` truthy-but-empty in two shapes.
  it('CS-05: dashed `[tests]` key is now parsed instead of silently dropped (key form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts"]\n\n`
        + `[exports.gens]\n\n`
        + `[tests]\n"smoke-test" = "tests/smoke.test.ts"\n`,
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(/tests\.smoke-test: tests\/smoke\.test\.ts/);
  });

  it('CS-05: empty `[tests]` section now fails instead of being silently skipped (empty form)', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts"]\n\n`
        + `[exports.gens]\n\n`
        + `[tests]\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/No tests declared/);
  });

  // CS-29 — `scope: :schedule` hard-failed "no sibling schedule.pool.rb"
  // on the same line where `✓ memory scope :schedule paired with cron`
  // printed, even though `cambium compile` accepts the input.
  it('CS-29: `scope: :schedule` no longer false-fails with "no sibling schedule.pool.rb"', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), JSON.stringify({ name: 'test_engine', version: '0.1.0' }));
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `export const TestReport = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], $id: 'TestReport' };\n`,
    );
    writeFileSync(join(scratch, 'test_gen.system.md'), 'You are a test agent.\n');
    writeFileSync(
      join(scratch, 'test_gen.cmb.rb'),
      `class TestGen < GenModel\n  model "omlx:stub"\n  system :test_gen\n`
        + `  memory :recent, scope: :schedule, top_k: 5\n  cron :daily\n  returns TestReport\n`
        + `  def analyze(x)\n    generate "x" do\n      returns TestReport\n    end\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/memory scope :schedule paired with cron/);
    expect(output).not.toMatch(/no sibling schedule\.pool\.rb/);
  });

  // CS-30 — the pipeline `def` counter kept counting after a `private`
  // keyword, so a legal pipeline with private helpers false-failed
  // "declares N public methods."
  it('CS-30: pipeline `def`s after `private` are no longer counted as public methods', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/pipelines'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/pipelines/review.pipeline.rb'),
      `class Review < Pipeline\n  def review(doc)\n  end\n\n  private\n\n  def helper\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/declares 2 public methods/);
  });

  // CS-32 — the member walk re-implemented the glob logic without the
  // absolute/`..`/relative()-escape guards `expandMembers` already
  // carries, so a `members` entry naming a directory outside the
  // workspace root got linted.
  it('CS-32: `members` entries that escape the workspace root are rejected, not linted', () => {
    setupMinimalWorkspace(scratch);
    const outsideName = `cambium-lint-outside-${Date.now()}`;
    const outside = join(scratch, '..', outsideName);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'Genfile.toml'), `[package]\nname = "evil"\nversion = "0.1.0"\n`);

    try {
      writeFileSync(
        join(scratch, 'Genfile.toml'),
        `[workspace]\nmembers = ["../${basename(outside)}", "packages/*"]\n`,
      );
      const { status, output } = runLint(scratch);
      // `lintPackage`'s header is the directory basename, not the Genfile's
      // package.name — assert on the field that proves the outside
      // Genfile was actually read.
      expect(output).not.toMatch(/package\.name = "evil"/);
      // AUD-217-02: rejecting the escaping member is not enough on its
      // own — it must be *reported*, not dropped in silence (satisfied by
      // exactly the silence this assertion used to lack).
      expect(status).toBe(1);
      expect(output).toMatch(new RegExp(`members entry ".*${outsideName}.*" — .+; not linted`));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// STEP-003a (DEC-011) — DEV-001 regression: STEP-003's reuse of
// `expandMembers` silently drops a literal `members` entry with no
// Genfile.toml, converting the old loud "Genfile.toml — not found" /
// "Cannot lint without Genfile.toml" fail into a silent omission. A
// glob sweeping over a non-package directory must stay silent — that
// asymmetry is the whole point of DEC-011. Both red against 6ca61bb.
describe('cambium lint — issue #217 STEP-003a (literal vs. glob member misses)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-003a-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('literal member naming a directory with no Genfile.toml fails loudly', () => {
    mkdirSync(join(scratch, 'packages', 'notapackage'), { recursive: true });
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/notapackage"]\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/Genfile\.toml — not found/);
    expect(output).toMatch(/Cannot lint without Genfile\.toml/);
    expect(output).not.toMatch(/✓ All checks passed\./);
  });

  it('glob member sweeping a non-package directory skips it silently and still lints real packages', () => {
    setupMinimalWorkspace(scratch);
    mkdirSync(join(scratch, 'packages', 'notapackage'), { recursive: true });

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).toMatch(/Package: testpkg/);
    expect(output).toMatch(/package\.name = "testpkg"/);
    expect(output).not.toMatch(/notapackage/);
    expect(output).not.toMatch(/Genfile\.toml — not found/);
    expect(output).not.toMatch(/error\(s\)/);
  });
});

// STEP-006a (DEC-012) — audit round 1 fixes against
// records/AUDIT-217-phaseA-2026-09-03.md. Each test is red at 0a4f318
// and green after; see records/CHANGE-217-phaseA-2026-09-03.md § Audit
// round 1 fixes for the stash/pop transcripts.
describe('cambium lint — issue #217 STEP-006a (audit round 1 fixes)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-006a-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  // AUD-217-02 — resolveMembers computes a `rejected` array specifically
  // so a caller can report which path guard fired; lint's call site
  // destructured only `{ accepted, missingGenfile }` and dropped it.
  // Every rejected pattern is something lint genuinely could not check —
  // a literal the author named specifically, or (since AUD-217-08) a
  // glob whose parent directory couldn't be scanned — so it earns a loud
  // fail, same DEC-011 reasoning as `missingGenfile`.
  it('AUD-217-02 variant A: a `..`-segment member entry fails loudly, not `✓ All checks passed.`', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["../outside"]\n`);

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/members entry "\.\.\/outside" — .+; not linted/);
    expect(output).not.toMatch(/✓ All checks passed\./);
  });

  it('AUD-217-02 variant B: an absolute-path member entry fails loudly, not `✓ All checks passed.`', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["/etc/definitely-not-here"]\n`);

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/members entry "\/etc\/definitely-not-here" — .+; not linted/);
    expect(output).not.toMatch(/✓ All checks passed\./);
  });

  // Reachable only post-STEP-001: the deleted hand-rolled TOML parser
  // stringified every array element; smol-toml returns a native number,
  // which `resolveMembers` had no representation for at all (fell
  // through `typeof pattern !== 'string'` into none of the three arrays).
  it('AUD-217-02 variant C: a non-string (TOML integer) member entry fails loudly, not `✓ All checks passed.`', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = [42]\n`);

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/members entry 42 — not a string; not linted/);
    expect(output).not.toMatch(/✓ All checks passed\./);
  });

  // AUD-217-01 — smol-toml throws on any spec violation where the
  // deleted hand-rolled parser was total; neither of lint's two parse
  // call sites caught it, so a malformed member Genfile.toml killed the
  // whole run with a raw TomlError and every later member went unlinted.
  it('AUD-217-01: a malformed member Genfile.toml fails that member loudly and lint still reaches the next one', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/*"]\n`);

    const bad = join(scratch, 'packages', 'aaa');
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      join(bad, 'Genfile.toml'),
      `[package]\nname = "aaa"\nname = "aaa2"\nversion = "0.1.0"\n`, // duplicate key
    );

    const good = join(scratch, 'packages', 'zzz');
    mkdirSync(join(good, 'tests'), { recursive: true });
    writeFileSync(
      join(good, 'Genfile.toml'),
      `[package]\nname = "zzz"\nversion = "0.1.0"\nkinds = ["app"]\n\n[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );
    writeFileSync(join(good, 'tests/smoke.test.ts'), '// placeholder\n');

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/Genfile\.toml — not valid TOML: .+/);
    expect(output).not.toMatch(/TomlError/);
    // The crash used to kill the process before "zzz" was ever reached —
    // this proves the walk continues past the bad member.
    expect(output).toMatch(/Package: zzz/);
    expect(output).toMatch(/package\.name = "zzz"/);
  });

  // AUD-217-04 — the other half of the same drop-in assumption:
  // smol-toml returns native TOML types where the deleted parser
  // stringified everything, so a non-string scalar in a path position
  // crashed join() instead of producing a diagnostic.
  it('AUD-217-04: a non-string `tests` path value fails with a diagnostic instead of crashing join()', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts"]\n\n`
        + `[tests]\nsmoke = 1\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/tests\.smoke: expected a string path, got number/);
  });

  // AUD-217-06 — the `private` truncation recognized only the bare
  // keyword; `protected` still counted its helpers as public.
  it('AUD-217-06: pipeline `def`s after `protected` are no longer counted as public methods', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/pipelines'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/pipelines/review.pipeline.rb'),
      `class Review < Pipeline\n  def review(doc)\n  end\n\n  protected\n\n  def helper\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/declares 2 public methods/);
  });

  // AUD-217-06 — a bare `private` line inside an `=begin`/`=end` block
  // comment truncated the scan on raw content, silently dropping every
  // real `def` that came after the comment block.
  it('AUD-217-06: a `private` line inside an `=begin`/`=end` block comment does not truncate the scan', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/pipelines'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/pipelines/review.pipeline.rb'),
      `class Review < Pipeline\n  def review(doc)\n  end\n\n`
        + `=begin\n  Internal note: keep everything below this private\n  private\n=end\n\n`
        + `  def another_public(y)\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    // `review` and `another_public` are both real, live public methods —
    // failing here is correct. The bug was that the block comment's
    // `private` line hid `another_public` from the scan entirely, so
    // lint reported only one method and passed.
    expect(status).toBe(1);
    expect(output).toMatch(/declares 2 public methods \(:review, :another_public\)/);
  });

  // Locks in the inline `private def name` form, which the audit found
  // already worked — by two narrower behaviors cancelling out, not by
  // design — so a future change to either the truncation regex or the
  // `def` regex can't silently break it.
  it('inline `private def name` form still excludes only that method, not a later public def', () => {
    const pkg = setupMinimalWorkspace(scratch);
    mkdirSync(join(pkg, 'app/pipelines'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/pipelines/review.pipeline.rb'),
      `class Review < Pipeline\n  private def helper(x)\n  end\n\n  def review(doc)\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(0);
    expect(output).not.toMatch(/declares no entry method/);
    expect(output).not.toMatch(/declares 2 public methods/);
  });
});

// Round 2 of AUDIT-217-phaseA — the fifth instance of the DEC-012
// pattern, plus two round-1 residues. Both red against 3a0a127.
describe('cambium lint — issue #217 audit round 2 fixes (STEP-006b)', () => {
  let scratch: string;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-lint-217-r2-'));
  });
  afterEach(() => {
    if (scratch && existsSync(scratch)) {
      // A permission-restricted `packages/` dir must be readable again
      // before recursive removal can walk it.
      try { chmodSync(join(scratch, 'packages'), 0o755); } catch { /* not present */ }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // AUD-217-08 — resolveMembers's glob branch swallowed a readdirSync
  // failure on the glob's parent directory (`catch { continue; }`), so a
  // `members = ["packages/*"]` whose `packages` is a file (ENOTDIR) or
  // unreadable (EACCES) — even with a valid package inside — silently
  // produced `✓ All checks passed.` / exit 0, where the inline walk this
  // helper replaced crashed loudly.
  it('AUD-217-08: a glob parent that is a file (ENOTDIR) fails loudly, not `✓ All checks passed.`', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/*"]\n`);
    writeFileSync(join(scratch, 'packages'), 'not a directory\n');

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/members entry "packages\/\*" — could not read packages: ENOTDIR.*; not linted/);
    expect(output).not.toMatch(/✓ All checks passed\./);
  });

  // EACCES needs a non-root process to actually deny the read — running
  // as root bypasses the permission bits entirely, so skip rather than
  // false-fail in a root-run CI container.
  it.skipIf(isRoot)(
    'AUD-217-08: a glob parent that is unreadable (EACCES) fails loudly and does not silently drop the valid package inside',
    () => {
      const pkg = join(scratch, 'packages', 'real');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'Genfile.toml'), `[package]\nname = "real"\nversion = "0.1.0"\n`);
      writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/*"]\n`);
      chmodSync(join(scratch, 'packages'), 0o000);

      const { status, output } = runLint(scratch);
      expect(status).toBe(1);
      expect(output).toMatch(/members entry "packages\/\*" — could not read packages: EACCES.*; not linted/);
      expect(output).not.toMatch(/✓ All checks passed\./);
      // The false green this closes is specifically that "real" — a
      // present, valid package — never gets a mention either way.
      expect(output).not.toMatch(/package\.name = "real"/);
    },
  );

  // AUD-217-09 — the AUD-217-04 guard landed at three of the five
  // `types.contracts` consumption sites; the gens `returns <Schema>`
  // check and the pipeline `input …, schema:` check each re-derive the
  // array inline and still crashed join() on a non-string entry.
  it('AUD-217-09: a non-string `types.contracts` entry no longer crashes the gens `returns <Schema>` check', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts", 7]\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );
    writeFileSync(join(pkg, 'src/contracts.ts'), 'export const TestReport = {};\n');
    mkdirSync(join(pkg, 'app/gens'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/gens/g.cmb.rb'),
      `class G < GenModel\n  returns TestReport\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/types\.contracts: expected a string path, got number/);
    expect(output).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    // The good entry alongside the bad one still resolves the schema —
    // the bad entry is skipped, not the whole check.
    expect(output).toMatch(/g\.cmb\.rb: returns TestReport \(found in src\/contracts\.ts\)/);
  });

  it('AUD-217-09: a non-string `types.contracts` entry no longer crashes the pipeline `input …, schema:` check', () => {
    const pkg = setupMinimalWorkspace(scratch);
    writeFileSync(
      join(pkg, 'Genfile.toml'),
      `[package]\nname = "testpkg"\nversion = "0.1.0"\n\n`
        + `[types]\ncontracts = ["src/contracts.ts", 7]\n\n`
        + `[tests]\nsmoke = "tests/smoke.test.ts"\n`,
    );
    writeFileSync(join(pkg, 'src/contracts.ts'), 'export const Foo = {};\n');
    mkdirSync(join(pkg, 'app/pipelines'), { recursive: true });
    writeFileSync(
      join(pkg, 'app/pipelines/review.pipeline.rb'),
      `class Review < Pipeline\n  input :doc, schema: Foo\n\n  def review(doc)\n  end\nend\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    expect(output).toMatch(/types\.contracts: expected a string path, got number/);
    expect(output).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    // The good entry alongside the bad one still resolves the schema —
    // no "not exported" fail for Foo.
    expect(output).not.toMatch(/input schema Foo not exported/);
  });

  // AUD-217-10 — the `rejected` loop used to run after the member walk,
  // so a rejected entry rendered as if it belonged to whichever
  // package's block happened to print last.
  it('AUD-217-10: a rejected `members` entry is reported under its own heading, not attributed to a package', () => {
    setupMinimalWorkspace(scratch);
    writeFileSync(
      join(scratch, 'Genfile.toml'),
      `[workspace]\nmembers = ["packages/*", "/etc/definitely-not-here"]\n`,
    );

    const { status, output } = runLint(scratch);
    expect(status).toBe(1);
    const workspaceIdx = output.indexOf('Workspace:');
    const rejectedIdx = output.indexOf('members entry "/etc/definitely-not-here"');
    const packageIdx = output.indexOf('Package: testpkg');
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(rejectedIdx).toBeGreaterThan(-1);
    expect(packageIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeLessThan(rejectedIdx);
    // Reported before the package block, not appended after it.
    expect(rejectedIdx).toBeLessThan(packageIdx);
  });

  // AUD-217-10 — smol-toml's parse-error message carries a multi-line
  // code frame under its headline. Phase B's Recorder assumes one line
  // per check (DEC-003's `· <id> — <reason>` format); the fail line must
  // stay single-line now so Phase B doesn't inherit a format violation.
  it('AUD-217-10: a malformed member Genfile.toml reports a single-line reason, not a multi-line code frame', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nmembers = ["packages/*"]\n`);
    const bad = join(scratch, 'packages', 'aaa');
    mkdirSync(bad, { recursive: true });
    writeFileSync(
      join(bad, 'Genfile.toml'),
      `[package]\nname = "aaa"\nname = "aaa2"\nversion = "0.1.0"\n`, // duplicate key
    );

    const { output } = runLint(scratch);
    expect(output).toMatch(
      /Genfile\.toml — not valid TOML: Invalid TOML document: trying to redefine an already defined table or value/,
    );
    // smol-toml's code-frame lines (e.g. "2:  name = ...") must not leak
    // into the output as their own lines.
    expect(output).not.toMatch(/^\d+:\s+name = /m);
  });
});
