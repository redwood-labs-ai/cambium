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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
