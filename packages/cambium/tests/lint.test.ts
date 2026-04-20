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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
});
