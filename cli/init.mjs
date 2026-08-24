#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Framework root resolved from the CLI's own location, not cwd (RED-274) —
// used only to read Cambium's own version for the scaffolded package.json.
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(CLI_DIR, '..');

// Exact pins for the scaffolded workspace, matching Cambium's own tree.
// Exact, not ranged, for the same reason Cambium pins its own deps — see
// SECURITY.md § Supply-chain defenses. `scaffold_package_json.test.ts`
// asserts these still match the versions Cambium resolves, so a bump here
// that drifts from the runner fails the build instead of going stale.
const SCAFFOLD_TYPEBOX = '0.34.49'; // == cambium-runner's @sinclair/typebox
const SCAFFOLD_VITEST = '3.2.7';    // == root devDependencies.vitest

/** Cambium's own version, so a fresh scaffold depends on the CLI that made it. */
function cambiumVersion() {
  try {
    return JSON.parse(readFileSync(join(FRAMEWORK_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    // Unreadable (unusual install layout) — omit the pin rather than guess a
    // version that may not exist on the registry.
    return null;
  }
}

function writeFile(path, content) {
  if (existsSync(path)) {
    console.log(`  exists: ${path} (skipped)`);
    return;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  console.log(`  created: ${path}`);
}

export function runInit(name) {
  const pkgName = name ?? 'my-gen-app';

  console.log(`\n\x1b[1mInitializing Cambium workspace: ${pkgName}\x1b[0m\n`);

  // Workspace root
  writeFile('Genfile.toml', `[workspace]\nmembers = ["packages/*"]\n`);

  // Workspace package.json (issue #161). Without this the scaffold cannot
  // run at all: Node resolves module type from the nearest package.json
  // walking up, so with none present `src/contracts.ts` loads as CJS and
  // `cambium run` dies with ERR_REQUIRE_CYCLE_MODULE. `cambium test` shells
  // out to `npx vitest run`, which also needs vitest declared somewhere.
  // One file at the workspace root covers every packages/* member.
  const version = cambiumVersion();
  writeFile('package.json', JSON.stringify({
    name: pkgName,
    version: '0.1.0',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    scripts: { test: 'vitest run' },
    dependencies: {
      ...(version ? { '@redwood-labs/cambium': version } : {}),
      '@sinclair/typebox': SCAFFOLD_TYPEBOX,
    },
    devDependencies: { vitest: SCAFFOLD_VITEST },
  }, null, 2) + '\n');

  // Package structure
  const pkg = `packages/${pkgName}`;

  writeFile(join(pkg, 'Genfile.toml'), `\
[package]
name = "${pkgName}"
version = "0.1.0"
kinds = ["app"]

[docs]
root = "docs"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]

[tests]
smoke = "tests/smoke.test.ts"
`);

  // Directory structure. Created eagerly so `cambium lint` can walk
  // every convention dir even before any scaffolding happens — each
  // `cambium new <type>` would create its dir lazily, but leaving them
  // empty in the starter layout makes the workspace's shape discoverable.
  // Convention surfaces: gens / systems / tools (RED-209) / actions
  // (RED-212) / correctors (RED-275) / providers (RED-393) / policies
  // (RED-214) / memory_pools (RED-215) / config (RED-237 + RED-239) /
  // log_profiles (RED-302) / logs (RED-302 app plugins).
  const dirs = [
    `${pkg}/app/gens`,
    `${pkg}/app/systems`,
    `${pkg}/app/tools`,
    `${pkg}/app/actions`,
    `${pkg}/app/correctors`,
    `${pkg}/app/providers`,
    `${pkg}/app/policies`,
    `${pkg}/app/memory_pools`,
    `${pkg}/app/log_profiles`,
    `${pkg}/app/logs`,
    `${pkg}/app/config`,
    `${pkg}/src`,
    `${pkg}/tests`,
    `${pkg}/examples/fixtures`,
    `${pkg}/docs`,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Starter contracts
  writeFile(join(pkg, 'src/contracts.ts'), `\
import { Type } from '@sinclair/typebox'

// Define your schemas here. Each schema needs a unique $id.
// Example:
//
// export const MyReport = Type.Object(
//   {
//     summary: Type.String(),
//     findings: Type.Array(Type.Object({
//       finding: Type.String(),
//     }, { additionalProperties: false })),
//   },
//   { additionalProperties: false, $id: 'MyReport' }
// )
`);

  // Starter test
  writeFile(join(pkg, 'tests/smoke.test.ts'), `\
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('placeholder', () => {
    // TODO: scaffold an agent and add a real test
    expect(true).toBe(true)
  })
})
`);

  // Starter fixture
  writeFile(join(pkg, 'examples/fixtures/sample.txt'), `\
This is a sample input document.
Replace this with real data for your agent.
`);

  console.log(`
\x1b[1mWorkspace ready!\x1b[0m

Next steps:
  1. Install dependencies:
     npm install

  2. Scaffold your first agent:
     cambium new agent MyAnalyst

  3. Define a schema in ${pkg}/src/contracts.ts

  4. Edit the system prompt in ${pkg}/app/systems/

  5. Run it:
     cambium run ${pkg}/app/gens/my_analyst.cmb.rb --method analyze --arg ${pkg}/examples/fixtures/sample.txt

  6. Check your setup:
     cambium lint

  7. Run tests:
     cambium test
`);
}
