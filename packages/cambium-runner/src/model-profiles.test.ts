/**
 * RED-326: integration tests for `profile :name do ... end` blocks in
 * `app/config/models.rb`.
 *
 * Spawns the actual Ruby compile.rb against tmp-dir fixtures so the
 * full env-var → ModelAliases.load → IR `model.id` chain is exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPILE_RB = resolve(__dirname, '../../..', 'ruby/cambium/compile.rb');

const CONTRACTS = `
export const Anything = { $id: 'Anything', type: 'object', additionalProperties: true };
`;

const GEN = `
class G < GenModel
  model :default
  returns Anything

  def analyze(input)
    generate "ok" do
      returns Anything
    end
  end
end
`;

describe('models.rb profile blocks (RED-326)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-red326-'));
    mkdirSync(join(tmp, 'app/gens'), { recursive: true });
    mkdirSync(join(tmp, 'app/config'), { recursive: true });
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src/contracts.ts'), CONTRACTS);
    writeFileSync(join(tmp, 'app/gens/g.cmb.rb'), GEN);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeModels(body: string): void {
    writeFileSync(join(tmp, 'app/config/models.rb'), body);
  }

  function runCompile(
    args: string[],
    env: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('ruby', [COMPILE_RB, ...args], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  function compileAndGetModelId(env: Record<string, string> = {}): string {
    const { status, stdout, stderr } = runCompile(
      [join(tmp, 'app/gens/g.cmb.rb'), '--method', 'analyze'],
      env,
    );
    if (status !== 0) {
      throw new Error(`compile failed: ${stderr}`);
    }
    const parsed = JSON.parse(stdout);
    return parsed.model.id;
  }

  // ── profile resolution ─────────────────────────────────────────────

  it('with no profile blocks declared, behaves exactly as RED-237 (back-compat)', () => {
    writeModels(`
default "omlx:legacy-model"
`);
    expect(compileAndGetModelId()).toBe('omlx:legacy-model');
  });

  it('with profiles and no env var set, prefers `:dev` if declared', () => {
    writeModels(`
profile :dev do
  default "omlx:dev-model"
end

profile :prod do
  default "anthropic:prod-model"
end
`);
    // Explicitly unset CAMBIUM_PROFILE in case the test runner inherited one.
    expect(compileAndGetModelId({ CAMBIUM_PROFILE: '' })).toBe('omlx:dev-model');
  });

  it('with profiles and no `:dev`, picks the first declared profile', () => {
    writeModels(`
profile :alpha do
  default "omlx:alpha-model"
end

profile :beta do
  default "omlx:beta-model"
end
`);
    expect(compileAndGetModelId({ CAMBIUM_PROFILE: '' })).toBe('omlx:alpha-model');
  });

  it('CAMBIUM_PROFILE env var selects the matching profile', () => {
    writeModels(`
profile :dev do
  default "omlx:dev-model"
end

profile :prod do
  default "anthropic:prod-model"
end
`);
    expect(compileAndGetModelId({ CAMBIUM_PROFILE: 'prod' })).toBe('anthropic:prod-model');
  });

  it('CAMBIUM_PROFILE with unknown name raises a CompileError listing declared profiles', () => {
    writeModels(`
profile :dev do
  default "omlx:dev-model"
end

profile :prod do
  default "anthropic:prod-model"
end
`);
    const { status, stderr } = runCompile(
      [join(tmp, 'app/gens/g.cmb.rb'), '--method', 'analyze'],
      { CAMBIUM_PROFILE: 'staging' },
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/CAMBIUM_PROFILE='staging'/);
    expect(stderr).toMatch(/Available: \[dev, prod\]/);
  });

  // ── shadowing and globals ─────────────────────────────────────────

  it('profile-scoped aliases shadow globals of the same name', () => {
    writeModels(`
default "omlx:global-default"

profile :prod do
  default "anthropic:prod-default"
end
`);
    expect(compileAndGetModelId({ CAMBIUM_PROFILE: 'prod' })).toBe('anthropic:prod-default');
  });

  it('globals are available across all profiles when not shadowed', () => {
    writeModels(`
codereview "anthropic:claude-opus-4-7"

profile :dev do
  default "omlx:dev-model"
end
`);
    // Re-fixture the gen to reference :codereview (a global), running
    // in the :dev profile. Global wins because :dev didn't declare it.
    writeFileSync(
      join(tmp, 'app/gens/g.cmb.rb'),
      GEN.replace(':default', ':codereview'),
    );
    expect(compileAndGetModelId({ CAMBIUM_PROFILE: 'dev' })).toBe(
      'anthropic:claude-opus-4-7',
    );
  });

  // ── error surfaces ─────────────────────────────────────────────────

  it('unknown alias in an active profile lists profile context in the error', () => {
    writeModels(`
profile :dev do
  default "omlx:dev-model"
end

profile :prod do
  fast "anthropic:fast-model"
end
`);
    // Gen references :default but :prod doesn't define it (and there's
    // no global default).
    const { status, stderr } = runCompile(
      [join(tmp, 'app/gens/g.cmb.rb'), '--method', 'analyze'],
      { CAMBIUM_PROFILE: 'prod' },
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown model alias :default/);
    expect(stderr).toMatch(/active profile: :prod/);
    expect(stderr).toMatch(/declared profiles: \[dev, prod\]/);
  });

  it('duplicate profile name raises CompileError', () => {
    writeModels(`
profile :dev do
  default "omlx:first"
end

profile :dev do
  default "omlx:second"
end
`);
    const { status, stderr } = runCompile([
      join(tmp, 'app/gens/g.cmb.rb'),
      '--method',
      'analyze',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/duplicate profile :dev/);
  });

  it('duplicate alias within the same profile raises CompileError', () => {
    writeModels(`
profile :dev do
  default "omlx:first"
  default "omlx:second"
end
`);
    const { status, stderr } = runCompile([
      join(tmp, 'app/gens/g.cmb.rb'),
      '--method',
      'analyze',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/duplicate model alias :default in profile :dev/);
  });

  it('nested profile blocks raise CompileError', () => {
    writeModels(`
profile :dev do
  default "omlx:m"
  profile :inner do
    default "omlx:n"
  end
end
`);
    const { status, stderr } = runCompile([
      join(tmp, 'app/gens/g.cmb.rb'),
      '--method',
      'analyze',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/profile blocks cannot nest/);
  });

  it('profile name validates against the snake_case regex', () => {
    writeModels(`
profile :"BadName" do
  default "omlx:m"
end
`);
    const { status, stderr } = runCompile([
      join(tmp, 'app/gens/g.cmb.rb'),
      '--method',
      'analyze',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/profile name must match/);
  });
});
