#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  // (RED-212) / correctors (RED-275) / policies (RED-214) / memory_pools
  // (RED-215) / config (RED-237 + RED-239).
  const dirs = [
    `${pkg}/app/gens`,
    `${pkg}/app/systems`,
    `${pkg}/app/tools`,
    `${pkg}/app/actions`,
    `${pkg}/app/correctors`,
    `${pkg}/app/policies`,
    `${pkg}/app/memory_pools`,
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
  1. Scaffold your first agent:
     cambium new agent MyAnalyst

  2. Define a schema in ${pkg}/src/contracts.ts

  3. Edit the system prompt in ${pkg}/app/systems/

  4. Run it:
     cambium run ${pkg}/app/gens/my_analyst.cmb.rb --method analyze --arg ${pkg}/examples/fixtures/sample.txt

  5. Check your setup:
     cambium lint

  6. Run tests:
     cambium test
`);
}
