/**
 * RED-246: scaffolder mode-detection + `cambium new engine` integration.
 *
 * The unit suite exercises detectScaffoldContext and validateName as pure
 * functions against temp directory layouts. The integration suite spawns
 * `node cli/cambium.mjs new ...` from inside scratch dirs to confirm the
 * dispatch picks the right destination (engine sibling vs app/<type>/)
 * and refuses to scaffold without a context.
 *
 * Engine-mode tests must NOT produce `app/<type>/` directories inside an
 * engine folder — that's the failure mode RED-220 (and the first
 * real-world integration attempt) explicitly traps for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectScaffoldContext, validateName, snakeCase, pascalCase } from '../../../cli/generate.mjs';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cambium-scaffold-'));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

// ── Pure helpers ──────────────────────────────────────────────────────

describe('detectScaffoldContext', () => {
  it('returns engine when cambium.engine.json is in cwd', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const ctx = detectScaffoldContext(scratch);
    expect(ctx.mode).toBe('engine');
    expect(ctx.engineDir).toBe(scratch);
  });

  it('returns engine when sentinel is at an ancestor', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const sub = join(scratch, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const ctx = detectScaffoldContext(sub);
    expect(ctx.mode).toBe('engine');
    expect(ctx.engineDir).toBe(scratch);
  });

  it('stops sentinel walk at the first package.json (boundary)', () => {
    // Layout: scratch/host/inner/cwd, with host/package.json (the boundary)
    // and a hypothetical sentinel at scratch/cambium.engine.json (across
    // the host's package.json). The walk must NOT reach past the host's
    // package.json to find the outer sentinel.
    const host = join(scratch, 'host');
    const cwd = join(host, 'inner');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(host, 'package.json'), '{}');
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');

    const ctx = detectScaffoldContext(cwd);
    expect(ctx.mode).not.toBe('engine');
  });

  it('returns app when Genfile.toml is at an ancestor', () => {
    writeFileSync(join(scratch, 'Genfile.toml'), '[workspace]');
    const sub = join(scratch, 'sub');
    mkdirSync(sub);
    const ctx = detectScaffoldContext(sub);
    expect(ctx.mode).toBe('app');
    expect(ctx.workspaceRoot).toBe(scratch);
  });

  it('returns app when a packages/cambium/ directory exists at an ancestor', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const ctx = detectScaffoldContext(scratch);
    expect(ctx.mode).toBe('app');
    expect(ctx.workspaceRoot).toBe(scratch);
  });

  it('prefers engine sentinel over app marker when both are present', () => {
    // scratch/Genfile.toml (would be app) AND scratch/cambium.engine.json (engine).
    // Engine wins because phase 1 of the walk runs first.
    writeFileSync(join(scratch, 'Genfile.toml'), '[workspace]');
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const ctx = detectScaffoldContext(scratch);
    expect(ctx.mode).toBe('engine');
  });

  it('returns none for a totally unmarked directory', () => {
    const ctx = detectScaffoldContext(scratch);
    expect(ctx.mode).toBe('none');
  });
});

describe('validateName', () => {
  it('accepts PascalCase and snake_case', () => {
    // validateName calls process.exit on failure; we only assert the no-throw path here.
    expect(() => validateName('Summarizer')).not.toThrow();
    expect(() => validateName('btc_analyst')).not.toThrow();
    expect(() => validateName('A')).not.toThrow();
    expect(() => validateName('a_b_c_123')).not.toThrow();
  });
  // Note: rejection paths process.exit(2) — exercised in the integration
  // suite below, where the subprocess returns the exit code.
});

describe('snakeCase / pascalCase', () => {
  it('snakeCase converts PascalCase', () => {
    expect(snakeCase('BtcAnalyst')).toBe('btc_analyst');
    expect(snakeCase('Summarizer')).toBe('summarizer');
  });
  it('pascalCase converts snake_case', () => {
    expect(pascalCase('btc_analyst')).toBe('BtcAnalyst');
    expect(pascalCase('summarizer')).toBe('Summarizer');
  });
});

// ── Integration: cambium new engine ───────────────────────────────────

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('cambium new engine — integration', () => {
  it('creates the engine folder shape with sentinel + CLAUDE.md + templates', () => {
    const result = runCli(['new', 'engine', 'Summarizer'], scratch);
    expect(result.status).toBe(0);

    const engineDir = join(scratch, 'cambium', 'summarizer');
    expect(existsSync(engineDir)).toBe(true);

    // Sentinel present and well-formed.
    const sentinelPath = join(engineDir, 'cambium.engine.json');
    expect(existsSync(sentinelPath)).toBe(true);
    const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    expect(sentinel.name).toBe('summarizer');
    expect(sentinel.version).toBe('0.1.0');
    expect(sentinel.createdBy).toBe('cambium new engine');

    // CLAUDE.md emitted.
    const claudeMd = readFileSync(join(engineDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Cambium engine folder');
    expect(claudeMd).toContain('runtime will not find files placed there'); // anti-app/<type>/ guidance

    // Gen, system prompt, schemas, typed wrapper.
    expect(existsSync(join(engineDir, 'summarizer.cmb.rb'))).toBe(true);
    expect(existsSync(join(engineDir, 'summarizer.system.md'))).toBe(true);
    expect(existsSync(join(engineDir, 'schemas.ts'))).toBe(true);
    expect(existsSync(join(engineDir, 'index.ts'))).toBe(true);

    // Wrapper imports from @redwood-labs/cambium-runner — the public package boundary.
    const indexTs = readFileSync(join(engineDir, 'index.ts'), 'utf8');
    expect(indexTs).toContain("from '@redwood-labs/cambium-runner'");
    expect(indexTs).toContain("from './schemas.js'");
    expect(indexTs).toContain('export async function analyze');

    // Schema $id matches the gen's `returns SummarizerReport`.
    const schemasTs = readFileSync(join(engineDir, 'schemas.ts'), 'utf8');
    expect(schemasTs).toContain('SummarizerReport');
    expect(schemasTs).toContain("$id: 'SummarizerReport'");

    // No `app/` subdirectory inside the engine — this is the trap RED-246
    // exists to prevent.
    expect(existsSync(join(engineDir, 'app'))).toBe(false);
  });

  it('refuses to scaffold an engine inside an existing engine folder', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{"name":"outer"}');
    const result = runCli(['new', 'engine', 'Inner'], scratch);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/Already inside an engine folder/);
  });

  it('refuses an invalid engine name (path traversal)', () => {
    const result = runCli(['new', 'engine', '../evil'], scratch);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/Invalid engine name/);
  });
});

// ── Integration: cambium new <type> mode awareness ────────────────────

describe('cambium new <type> — engine mode places siblings of the gen', () => {
  beforeEach(() => {
    // Set up an engine folder and chdir into it.
    writeFileSync(join(scratch, 'cambium.engine.json'), JSON.stringify({
      name: 'test_engine', version: '0.1.0', createdBy: 'test fixture',
    }));
  });

  it('cambium new tool — drops .tool.{json,ts} as siblings of the gen, NOT under app/tools/', () => {
    const result = runCli(['new', 'tool', 'price_fetcher'], scratch);
    expect(result.status).toBe(0);

    expect(existsSync(join(scratch, 'price_fetcher.tool.json'))).toBe(true);
    expect(existsSync(join(scratch, 'price_fetcher.tool.ts'))).toBe(true);
    expect(existsSync(join(scratch, 'app'))).toBe(false);

    // Engine-mode tools import ToolContext from the published package, not
    // a relative path into packages/cambium-runner/.
    const toolTs = readFileSync(join(scratch, 'price_fetcher.tool.ts'), 'utf8');
    expect(toolTs).toContain("from '@redwood-labs/cambium-runner'");
  });

  it('cambium new agent — drops .cmb.rb and .system.md as siblings, no app/ dirs', () => {
    const result = runCli(['new', 'agent', 'BtcAnalyst'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'btc_analyst.cmb.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'btc_analyst.system.md'))).toBe(true);
    expect(existsSync(join(scratch, 'app'))).toBe(false);
  });

  it('cambium new corrector — drops .corrector.ts as a sibling of the gen (RED-275 plugin shape)', () => {
    const result = runCli(['new', 'corrector', 'price_check'], scratch);
    expect(result.status).toBe(0);

    expect(existsSync(join(scratch, 'price_check.corrector.ts'))).toBe(true);
    expect(existsSync(join(scratch, 'app'))).toBe(false);

    // Engine-mode corrector imports from the published package, not a
    // relative framework path.
    const body = readFileSync(join(scratch, 'price_check.corrector.ts'), 'utf8');
    expect(body).toContain("from '@redwood-labs/cambium-runner'");
    expect(body).toContain('export const price_check: CorrectorFn');
  });

  // ── RED-289: cambium new schema in engine mode appends to schemas.ts ──

  it('cambium new schema — creates schemas.ts with typebox import when missing', () => {
    const result = runCli(['new', 'schema', 'FirstReport'], scratch);
    expect(result.status).toBe(0);
    const schemasPath = join(scratch, 'schemas.ts');
    expect(existsSync(schemasPath)).toBe(true);
    const body = readFileSync(schemasPath, 'utf8');
    expect(body).toContain("import { Type } from '@sinclair/typebox'");
    expect(body).toMatch(/export const FirstReport = Type\.Object\(/);
    expect(body).toMatch(/\$id: 'FirstReport'/);
  });

  it('cambium new schema — appends a new export to an existing schemas.ts', () => {
    // Seed the engine with one export; append a second.
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `import { Type } from '@sinclair/typebox';\n\nexport const Alpha = Type.Object({}, { $id: 'Alpha' });\n`,
    );
    const result = runCli(['new', 'schema', 'Beta'], scratch);
    expect(result.status).toBe(0);
    const body = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    // Both exports present; typebox import not duplicated.
    expect(body).toMatch(/export const Alpha\b/);
    expect(body).toMatch(/export const Beta\b/);
    expect(body.match(/@sinclair\/typebox/g)?.length ?? 0).toBe(1);
  });

  it('cambium new schema — idempotent when the export already exists', () => {
    writeFileSync(
      join(scratch, 'schemas.ts'),
      `import { Type } from '@sinclair/typebox';\n\nexport const Existing = Type.Object({}, { $id: 'Existing' });\n`,
    );
    const before = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    const result = runCli(['new', 'schema', 'Existing'], scratch);
    expect(result.status).toBe(0);
    const after = readFileSync(join(scratch, 'schemas.ts'), 'utf8');
    expect(after).toBe(before); // no change — already present
    const combined = (result.stderr ?? '') + (result.stdout ?? '');
    expect(combined).toMatch(/already exported/);
  });
});

describe('cambium new <type> — no context errors out', () => {
  it('errors when no engine sentinel and no app workspace marker exist', () => {
    // Bare temp dir, no markers. Should refuse anything besides `engine`.
    const result = runCli(['new', 'agent', 'Foo'], scratch);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/No Cambium context detected/);
  });

  it('still allows `cambium new engine` from a no-context directory', () => {
    const result = runCli(['new', 'engine', 'FromNothing'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'cambium', 'from_nothing', 'cambium.engine.json'))).toBe(true);
  });
});

// ── Regression: app-mode behavior is unchanged ────────────────────────
//
// Spawning `cambium new agent X` from the real repo root would clutter
// packages/cambium/app/gens/. We use a temp dir that mirrors the
// app-mode marker (a sibling packages/cambium/ directory) so the
// scaffolder picks app mode and writes there safely — into the temp
// dir, not the real repo.

describe('cambium new <type> — app mode (regression)', () => {
  it('writes to packages/cambium/app/gens/ when invoked inside an app workspace', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'agent', 'Throwaway'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'packages', 'cambium', 'app', 'gens', 'throwaway.cmb.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'packages', 'cambium', 'app', 'systems', 'throwaway.system.md'))).toBe(true);
  });

  it('cambium new tool writes paired files under packages/cambium/app/tools/', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'tool', 'echo_thing'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'packages', 'cambium', 'app', 'tools', 'echo_thing.tool.json'))).toBe(true);
    expect(existsSync(join(scratch, 'packages', 'cambium', 'app', 'tools', 'echo_thing.tool.ts'))).toBe(true);
  });

  // RED-275 + RED-284: app-mode correctors now write to app/correctors/
  // with the plugin shape, not to the framework's correctors/ directory.
  // The pre-RED-284 scaffolder wrote `packages/cambium-runner/src/correctors/`
  // which produced a file the runtime wouldn't discover (wrong shape, wrong path).
  it('cambium new corrector writes <snake>.corrector.ts under packages/cambium/app/correctors/', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'corrector', 'regex_verifies'], scratch);
    expect(result.status).toBe(0);

    const correctorPath = join(
      scratch, 'packages', 'cambium', 'app', 'correctors', 'regex_verifies.corrector.ts',
    );
    expect(existsSync(correctorPath)).toBe(true);

    // Must NOT land in the framework correctors directory (the pre-RED-284 bug).
    expect(existsSync(join(scratch, 'packages', 'cambium-runner', 'src', 'correctors'))).toBe(false);

    const body = readFileSync(correctorPath, 'utf8');
    // App-mode template imports types via the deep relative path to the runner
    // package — same stance generateTool takes for ToolContext.
    expect(body).toContain("from '../../../cambium-runner/src/correctors/types.js'");
    expect(body).toContain('export const regex_verifies: CorrectorFn');
  });
});

// ── RED-284: new scaffolders for action / policy / memory_pool / config ──

describe('cambium new <type> — RED-284 scaffolder additions', () => {
  it('cambium new action writes paired .action.{json,ts} under packages/cambium/app/actions/', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'action', 'slack_notify'], scratch);
    expect(result.status).toBe(0);

    const actionsDir = join(scratch, 'packages', 'cambium', 'app', 'actions');
    expect(existsSync(join(actionsDir, 'slack_notify.action.json'))).toBe(true);
    expect(existsSync(join(actionsDir, 'slack_notify.action.ts'))).toBe(true);

    const def = JSON.parse(readFileSync(join(actionsDir, 'slack_notify.action.json'), 'utf8'));
    expect(def.name).toBe('slack_notify');
    expect(def.permissions).toEqual({ pure: true });
    expect(def.inputSchema).toBeDefined();
    expect(def.outputSchema).toBeDefined();
  });

  it('cambium new action works in engine mode too', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const result = runCli(['new', 'action', 'debug_emit'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'debug_emit.action.json'))).toBe(true);
    expect(existsSync(join(scratch, 'debug_emit.action.ts'))).toBe(true);
    // Engine-mode template uses the package import.
    const body = readFileSync(join(scratch, 'debug_emit.action.ts'), 'utf8');
    expect(body).toContain("from '@redwood-labs/cambium-runner'");
  });

  it('cambium new policy writes <snake>.policy.rb under packages/cambium/app/policies/', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'policy', 'research_caps'], scratch);
    expect(result.status).toBe(0);
    const path = join(scratch, 'packages', 'cambium', 'app', 'policies', 'research_caps.policy.rb');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/security\s*:research_caps/);
  });

  it('cambium new policy refuses in engine mode', () => {
    writeFileSync(join(scratch, 'cambium.engine.json'), '{}');
    const result = runCli(['new', 'policy', 'p1'], scratch);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/not supported in engine mode/);
  });

  it('cambium new memory_pool writes <snake>.pool.rb under packages/cambium/app/memory_pools/', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'memory_pool', 'support_team'], scratch);
    expect(result.status).toBe(0);
    const path = join(scratch, 'packages', 'cambium', 'app', 'memory_pools', 'support_team.pool.rb');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/strategy :sliding_window/);
  });

  it('cambium new config models writes app/config/models.rb', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'config', 'models'], scratch);
    expect(result.status).toBe(0);
    const path = join(scratch, 'packages', 'cambium', 'app', 'config', 'models.rb');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/default\s+"omlx:/);
  });

  it('cambium new config memory_policy writes app/config/memory_policy.rb', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'config', 'memory_policy'], scratch);
    expect(result.status).toBe(0);
    const path = join(scratch, 'packages', 'cambium', 'app', 'config', 'memory_policy.rb');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/# max_ttl "90d"/);
  });

  it('cambium new config rejects unknown forms', () => {
    mkdirSync(join(scratch, 'packages', 'cambium'), { recursive: true });
    const result = runCli(['new', 'config', 'nonsense'], scratch);
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? '') + (result.stdout ?? ''))
      .toMatch(/Forms: models, memory_policy/);
  });
});

// ── RED-286: flat [package] layout (external apps, e.g. curator) ──────
//
// An external app has a single `Genfile.toml [package]` at project root
// and a flat `app/{gens,tools,...}/` tree — NO `packages/cambium/`
// subdir. Scaffolders must land files at the flat paths, not at a
// phantom `packages/cambium/app/...` tree the external project shouldn't
// have.

describe('cambium new <type> — flat [package] layout (RED-286)', () => {
  function setupFlatPackage(dir: string) {
    writeFileSync(
      join(dir, 'Genfile.toml'),
      `[package]\nname = "curator_dogfood"\nversion = "0.1.0"\n\n[types]\ncontracts = ["src/contracts.ts"]\n`,
    );
  }

  it('detectScaffoldContext returns appPkgRoot === cwd when Genfile is [package]', () => {
    setupFlatPackage(scratch);
    const ctx = detectScaffoldContext(scratch);
    expect(ctx.mode).toBe('app');
    expect(ctx.shape).toBe('package');
    expect(ctx.appPkgRoot).toBe(scratch);
    expect(ctx.workspaceRoot).toBe(scratch);
  });

  it('cambium new agent lands at <cwd>/app/gens/, not a phantom packages/cambium/', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'agent', 'ExtractPattern'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'app', 'gens', 'extract_pattern.cmb.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'app', 'systems', 'extract_pattern.system.md'))).toBe(true);
    // No phantom tree under packages/cambium/
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new tool lands at <cwd>/app/tools/ and imports ToolContext from @redwood-labs/cambium-runner', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'tool', 'price_fetcher'], scratch);
    expect(result.status).toBe(0);
    const tsPath = join(scratch, 'app', 'tools', 'price_fetcher.tool.ts');
    expect(existsSync(tsPath)).toBe(true);
    expect(existsSync(join(scratch, 'app', 'tools', 'price_fetcher.tool.json'))).toBe(true);
    // External app: @redwood-labs/cambium-runner package import, NOT a deep relative
    // into ../../../cambium-runner/ which wouldn't exist in curator.
    expect(readFileSync(tsPath, 'utf8')).toContain("from '@redwood-labs/cambium-runner'");
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new corrector lands at <cwd>/app/correctors/ and imports from @redwood-labs/cambium-runner', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'corrector', 'regex_compiles'], scratch);
    expect(result.status).toBe(0);
    const tsPath = join(scratch, 'app', 'correctors', 'regex_compiles.corrector.ts');
    expect(existsSync(tsPath)).toBe(true);
    expect(readFileSync(tsPath, 'utf8')).toContain("from '@redwood-labs/cambium-runner'");
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new action lands at <cwd>/app/actions/ and imports ToolContext from @redwood-labs/cambium-runner', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'action', 'slack_notify'], scratch);
    expect(result.status).toBe(0);
    const tsPath = join(scratch, 'app', 'actions', 'slack_notify.action.ts');
    expect(existsSync(tsPath)).toBe(true);
    expect(existsSync(join(scratch, 'app', 'actions', 'slack_notify.action.json'))).toBe(true);
    expect(readFileSync(tsPath, 'utf8')).toContain("from '@redwood-labs/cambium-runner'");
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new policy lands at <cwd>/app/policies/', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'policy', 'research_caps'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'app', 'policies', 'research_caps.policy.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new memory_pool lands at <cwd>/app/memory_pools/', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'memory_pool', 'support_team'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'app', 'memory_pools', 'support_team.pool.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new config models lands at <cwd>/app/config/', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'config', 'models'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'app', 'config', 'models.rb'))).toBe(true);
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });

  it('cambium new system lands at <cwd>/app/systems/', () => {
    setupFlatPackage(scratch);
    const result = runCli(['new', 'system', 'pattern_analyst'], scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, 'app', 'systems', 'pattern_analyst.system.md'))).toBe(true);
    expect(existsSync(join(scratch, 'packages'))).toBe(false);
  });
});
