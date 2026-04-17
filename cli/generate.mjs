#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import process from 'node:process';

// ── Constants ─────────────────────────────────────────────────────────

const ENGINE_SENTINEL = 'cambium.engine.json';

// Path-traversal guard (RED-222 / RED-246). Names flow into File.join
// segments; the regex blocks "..", "/", and shell metacharacters.
const NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

// ── Helpers ───────────────────────────────────────────────────────────

export function snakeCase(name) {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

export function pascalCase(name) {
  return name
    .replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase());
}

export function validateName(name, kind = 'name') {
  if (!name) {
    console.error(`Missing ${kind}.`);
    process.exit(2);
  }
  if (!NAME_REGEX.test(name)) {
    console.error(`Invalid ${kind}: "${name}". Must match /^[A-Za-z][A-Za-z0-9_]*$/.`);
    process.exit(2);
  }
}

function writeFile(path, content) {
  if (existsSync(path)) {
    console.error(`  exists: ${path} (skipped)`);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`  created: ${path}`);
  return true;
}

// ── Mode detection (RED-246) ──────────────────────────────────────────
//
// `cambium new <thing>` needs to know whether it's authoring inside an
// engine folder (sibling-of-gen layout, no `app/<type>/` subdirs) or an
// app-mode workspace (the existing `packages/cambium/app/<type>/<name>`
// layout). The decision is filesystem-driven so a single function works
// for every subcommand.
//
// Sentinel walk stops at the first `package.json` to avoid leaking out
// of an embedded engine into a parent project. The app-mode walk has no
// boundary — `Genfile.toml` or a sibling `packages/cambium/` is enough
// regardless of how deep we are in the host project.

export function detectScaffoldContext(cwd) {
  // Phase 1: walk up looking for the engine sentinel. Stop at the first
  // package.json — sentinel detection must not cross out of the host's
  // own project tree.
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ENGINE_SENTINEL))) {
      return { mode: 'engine', engineDir: dir };
    }
    if (existsSync(join(dir, 'package.json'))) {
      // Boundary — the sentinel must be at or below the host's package.json.
      // This prevents reaching past the host into a parent monorepo or an
      // unrelated outer package.
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Phase 2: no sentinel — try app-mode markers. No boundary check; the
  // monorepo layout is the legitimate use case here.
  dir = cwd;
  while (true) {
    if (existsSync(join(dir, 'Genfile.toml'))) {
      return { mode: 'app', workspaceRoot: dir };
    }
    if (existsSync(join(dir, 'packages', 'cambium'))) {
      return { mode: 'app', workspaceRoot: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { mode: 'none' };
}

function noContextError() {
  console.error(`\nNo Cambium context detected in this directory or its ancestors.`);
  console.error(`\nOptions:`);
  console.error(`  - Run 'cambium new engine <Name>' to create a new engine folder here.`);
  console.error(`  - cd into a Cambium workspace (one with packages/cambium/ or Genfile.toml).`);
  process.exit(2);
}

// ── Engine scaffolder (new in RED-246) ────────────────────────────────

function generateEngine(name, ctx) {
  validateName(name, 'engine name');

  if (ctx.mode === 'engine') {
    console.error(`\nAlready inside an engine folder (${ctx.engineDir}). Cannot nest engines.`);
    process.exit(2);
  }

  const snake = snakeCase(name);
  const pascal = pascalCase(name);
  const schemaName = `${pascal}Report`;

  // Convention: engines live under <cwd>/cambium/<snake>/. If the cwd is
  // already named "cambium", drop one level (treat cwd as the engines
  // container). Either way the engine folder ends up adjacent to the host's
  // src/ tree.
  const cwd = process.cwd();
  const engineDir = basename(cwd) === 'cambium'
    ? join(cwd, snake)
    : join(cwd, 'cambium', snake);

  if (existsSync(engineDir)) {
    console.error(`\nEngine folder already exists: ${engineDir}`);
    process.exit(2);
  }

  console.log(`\nGenerating engine: ${pascal} at ${engineDir}\n`);

  // Sentinel — the file every other tool keys off to detect engine mode.
  writeFile(join(engineDir, ENGINE_SENTINEL), JSON.stringify({
    name: snake,
    version: '0.1.0',
    createdBy: 'cambium new engine',
  }, null, 2) + '\n');

  // CLAUDE.md telling future LLM sessions the engine-mode conventions.
  writeFile(join(engineDir, 'CLAUDE.md'), `\
# Cambium engine folder — read this first

You are inside a Cambium engine folder (marked by \`cambium.engine.json\`). This is
**not** an app-mode workspace. The conventions are different:

- Tools, policies, systems, and memory pools live as **siblings** of the gen file.
  Filenames: \`<name>.tool.{ts,json}\`, \`<name>.policy.rb\`, \`<name>.system.md\`,
  \`<name>.pool.rb\`. No \`app/\`, \`app/tools/\`, \`app/policies/\` subdirectories
  inside this folder — the runtime will not find files placed there.
- Use \`cambium new tool <Name>\` (and the equivalents for policy / system / pool /
  schema) rather than writing files by hand. The scaffolder detects the engine
  context and places files correctly.
- The IR (\`${snake}.ir.json\`) and the typed wrapper (\`index.ts\`) are generated.
  Re-run \`cambium compile ${snake}.cmb.rb\` after editing the gen.
- Host code imports the typed wrapper: \`import { analyze } from './${snake}'\`.
`);

  // Gen file.
  writeFile(join(engineDir, `${snake}.cmb.rb`), `\
class ${pascal} < GenModel
  model "omlx:gemma-4-31b-it-8bit"
  system :${snake}
  temperature 0.2
  max_tokens 1200

  returns ${schemaName}

  # Optional: add tools, correctors, constraints, grounding
  # uses :web_search, :calculator
  # corrects :math
  # constrain :budget, max_tool_calls: 4
  # grounded_in :document, require_citations: true

  def analyze(input)
    generate "TODO: describe what this gen does" do
      with context: input
      returns ${schemaName}
    end
  end
end
`);

  // System prompt.
  writeFile(join(engineDir, `${snake}.system.md`), `\
You are a ${snake.replace(/_/g, ' ')}. TODO: describe the role, expertise, and behavioral expectations.`);

  // Schemas (TypeBox) — single source of truth for input/output validation.
  writeFile(join(engineDir, 'schemas.ts'), `\
// Engine schemas. The host passes this module to runGen so the runner can
// validate output against it. The schema \`$id\` MUST match the
// \`returns ${schemaName}\` declaration in ${snake}.cmb.rb.

import { Type } from '@sinclair/typebox';

export const ${schemaName} = Type.Object(
  {
    // TODO: define fields
    summary: Type.String(),
  },
  { additionalProperties: false, $id: '${schemaName}' },
);
`);

  // Typed wrapper that calls runGen. Generated; commit it.
  writeFile(join(engineDir, 'index.ts'), `\
// Generated by 'cambium new engine ${pascal}'. This file is the host's
// entry point — \`import { analyze } from './${snake}'\` and call it.
//
// Re-run \`cambium compile ${snake}.cmb.rb\` after editing the gen, and
// re-generate this file (or hand-edit the type signatures) when the
// schema shape changes.

import { runGen } from '@cambium/runner';
import * as schemas from './schemas.js';
import irData from './${snake}.ir.json' with { type: 'json' };
import type { Static } from '@sinclair/typebox';

export type ${pascal}Input = string;
export type ${pascal}Output = Static<typeof schemas.${schemaName}>;

export interface ${pascal}Options {
  /** Force the deterministic mock generator instead of a live LLM. */
  mock?: boolean;
}

/**
 * Run the ${snake} gen. The IR is bundled in ${snake}.ir.json — re-run
 * \`cambium compile\` after editing the gen.
 */
export async function analyze(
  input: ${pascal}Input,
  opts: ${pascal}Options = {},
): Promise<${pascal}Output> {
  // Stopgap until runGen takes \`input\` directly: shallow-clone the IR
  // and override the context.document field. Replace with the proper
  // option once the runGen API expands.
  const ir = {
    ...(irData as any),
    context: { ...((irData as any).context ?? {}), document: input },
  };
  const result = await runGen({
    ir: ir as never,
    schemas,
    mock: opts.mock,
  });
  if (!result.ok) {
    throw new Error(result.errorMessage ?? 'Gen failed');
  }
  return result.output as ${pascal}Output;
}
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${engineDir}/${snake}.cmb.rb — define the gen body.`);
  console.log(`  2. Edit ${engineDir}/${snake}.system.md — write the system prompt.`);
  console.log(`  3. Edit ${engineDir}/schemas.ts — define the return schema fields.`);
  console.log(`  4. Run: cambium compile ${engineDir}/${snake}.cmb.rb`);
  console.log(`  5. Review ${engineDir}/index.ts (the generated typed wrapper that calls runGen) before importing it in your host code.`);
  console.log(`  6. Import in your host: import { analyze } from './${join('cambium', snake)}'`);
}

// ── Existing scaffolders (mode-aware in RED-246) ──────────────────────

function generateAgent(name, ctx) {
  validateName(name, 'agent name');
  const snake = snakeCase(name);
  const pascal = pascalCase(name);
  const schemaName = `${pascal}Report`;

  console.log(`\nGenerating agent: ${pascal}\n`);

  if (ctx.mode === 'engine') {
    writeFile(join(ctx.engineDir, `${snake}.cmb.rb`), `\
class ${pascal} < GenModel
  model "omlx:gemma-4-31b-it-8bit"
  system :${snake}
  temperature 0.2
  max_tokens 1200

  returns ${schemaName}

  def analyze(input)
    generate "TODO: describe what this gen does" do
      with context: input
      returns ${schemaName}
    end
  end
end
`);

    writeFile(join(ctx.engineDir, `${snake}.system.md`), `\
You are a ${snake.replace(/_/g, ' ')}. TODO: describe the role and behavior.`);

    console.log(`\nNext steps:`);
    console.log(`  1. Define ${schemaName} in ${ctx.engineDir}/schemas.ts`);
    console.log(`  2. Edit ${ctx.engineDir}/${snake}.system.md`);
    console.log(`  3. Compile: cambium compile ${ctx.engineDir}/${snake}.cmb.rb`);
    return;
  }

  // App mode (or none, errored above).
  const PKG = join(ctx.workspaceRoot, 'packages/cambium');
  writeFile(join(PKG, 'app/gens', `${snake}.cmb.rb`), `\
class ${pascal} < GenModel
  model "omlx:gemma-4-31b-it-8bit"
  system :${snake}
  temperature 0.2
  max_tokens 1200

  returns ${schemaName}

  # Optional: add tools, correctors, constraints, grounding
  # uses :web_search, :calculator
  # corrects :math
  # constrain :budget, max_tool_calls: 4
  # grounded_in :document, require_citations: true

  def analyze(document)
    generate "analyze this document" do
      with context: document
      returns ${schemaName}
    end
  end
end
`);

  writeFile(join(PKG, 'app/systems', `${snake}.system.md`), `\
You are a ${pascal.replace(/([A-Z])/g, ' $1').trim().toLowerCase()}. You extract structured data from documents with precision.`);

  writeFile(join(PKG, 'tests', `${snake}.test.ts`), `\
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

describe('${pascal}', () => {
  it('compiles to valid IR', () => {
    // TODO: create a fixture and uncomment
    // const ir = JSON.parse(execSync(
    //   'ruby ruby/cambium/compile.rb ${PKG}/app/gens/${snake}.cmb.rb --method analyze --arg <fixture>',
    //   { encoding: 'utf8' },
    // ))
    // expect(ir.entry.class).toBe('${pascal}')
    expect(true).toBe(true)
  })
})
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Define ${schemaName} in ${PKG}/src/contracts.ts`);
  console.log(`  2. Edit ${PKG}/app/systems/${snake}.system.md`);
  console.log(`  3. Create a fixture in ${PKG}/examples/fixtures/`);
  console.log(`  4. Run: cambium run ${PKG}/app/gens/${snake}.cmb.rb --method analyze --arg <fixture>`);
}

function generateTool(name, ctx) {
  validateName(name, 'tool name');
  const snake = snakeCase(name);

  console.log(`\nGenerating tool: ${snake}\n`);

  // Tool definition is identical between modes — only the destination dir
  // and the ToolContext import path change.
  const toolJson = JSON.stringify({
    name: snake,
    description: `TODO: describe what ${snake} does`,
    permissions: { pure: true },
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'string' },
      },
      additionalProperties: false,
    },
  }, null, 2) + '\n';

  if (ctx.mode === 'engine') {
    writeFile(join(ctx.engineDir, `${snake}.tool.json`), toolJson);
    writeFile(join(ctx.engineDir, `${snake}.tool.ts`), `\
/**
 * Plugin tool handler. Auto-discovered alongside ${snake}.tool.json (RED-209).
 *
 * If this tool needs network access, declare it in the .tool.json
 * permissions block and use \`ctx.fetch\` here — NOT globalThis.fetch
 * (the SSRF guard lives on ctx.fetch; direct fetch bypasses it).
 */
import type { ToolContext } from '@cambium/runner';

export async function execute(
  input: { input: string },
  _ctx?: ToolContext,
): Promise<{ result: string }> {
  // TODO: implement ${snake}
  return { result: input.input };
}
`);

    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${ctx.engineDir}/${snake}.tool.json — input/output schemas + permissions`);
    console.log(`  2. Implement ${ctx.engineDir}/${snake}.tool.ts`);
    console.log(`  3. Declare in your gen: uses :${snake}`);
    return;
  }

  // App mode.
  const PKG = join(ctx.workspaceRoot, 'packages/cambium');
  writeFile(join(PKG, 'app/tools', `${snake}.tool.json`), toolJson);
  writeFile(join(PKG, 'app/tools', `${snake}.tool.ts`), `\
/**
 * Plugin tool handler. Auto-discovered alongside ${snake}.tool.json (RED-209).
 *
 * If this tool needs network access, declare it in the .tool.json
 * permissions block and use \`ctx.fetch\` here — NOT globalThis.fetch
 * (the SSRF guard lives on ctx.fetch; direct fetch bypasses it).
 */
import type { ToolContext } from '../../../cambium-runner/src/tools/tool-context.js';

export async function execute(
  input: { input: string },
  _ctx?: ToolContext,
): Promise<{ result: string }> {
  // TODO: implement ${snake}
  return { result: input.input };
}
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${PKG}/app/tools/${snake}.tool.json — input/output schemas + permissions`);
  console.log(`  2. Implement ${PKG}/app/tools/${snake}.tool.ts`);
  console.log(`  3. Declare in your agent: uses :${snake}`);
  console.log(`\nTip: try \`cambium new tool --describe "what it does"\` for an agentic scaffolder`);
  console.log(`     that infers the schema and permissions from a natural-language description.`);
}

function generateSchema(name, ctx) {
  validateName(name, 'schema name');
  const pascal = pascalCase(name);

  if (ctx.mode === 'engine') {
    console.log(`\nGenerating schema: ${pascal}\n`);
    console.log(`  Add the following to ${ctx.engineDir}/schemas.ts:\n`);
    console.log(`export const ${pascal} = Type.Object(
  {
    // TODO: define fields
    summary: Type.String(),
  },
  { additionalProperties: false, $id: '${pascal}' }
)\n`);
    console.log(`Then use in your gen: returns ${pascal}`);
    return;
  }

  const PKG = join(ctx.workspaceRoot, 'packages/cambium');
  console.log(`\nGenerating schema: ${pascal}\n`);
  console.log(`  Add the following to ${PKG}/src/contracts.ts:\n`);
  console.log(`export const ${pascal} = Type.Object(
  {
    // TODO: define fields
    summary: Type.String(),
  },
  { additionalProperties: false, $id: '${pascal}' }
)\n`);
  console.log(`Then use in your agent: returns ${pascal}`);
}

function generateSystem(name, ctx) {
  validateName(name, 'system name');
  const snake = snakeCase(name);

  console.log(`\nGenerating system prompt: ${snake}\n`);

  const dir = ctx.mode === 'engine'
    ? ctx.engineDir
    : join(ctx.workspaceRoot, 'packages/cambium/app/systems');

  writeFile(join(dir, `${snake}.system.md`), `\
You are a ${snake.replace(/_/g, ' ')}. TODO: describe the role, expertise, and behavioral expectations.`);

  console.log(`\nUse in your agent: system :${snake}`);
}

function generateCorrector(name, ctx) {
  validateName(name, 'corrector name');

  if (ctx.mode === 'engine') {
    console.error(`\n'cambium new corrector' is not supported in engine mode.`);
    console.error(`Correctors live inside the framework — they're shared across gens.`);
    console.error(`Add new correctors to packages/cambium-runner/src/correctors/ in the framework repo.`);
    process.exit(2);
  }

  const snake = snakeCase(name);

  console.log(`\nGenerating corrector: ${snake}\n`);

  const correctorsDir = join(ctx.workspaceRoot, 'packages/cambium-runner/src/correctors');

  writeFile(join(correctorsDir, `${snake}.ts`), `\
import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

export const ${snake}: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);

  // TODO: implement ${snake} corrector
  // Walk the output, validate/transform fields, push issues

  return {
    corrected: issues.some(i => i.severity === 'fixed'),
    output,
    issues,
    // meta: { ... }, // optional: add structured results for trace
  };
};
`);

  writeFile(join(correctorsDir, `${snake}.test.ts`), `\
import { describe, it, expect } from 'vitest'
import { ${snake} } from './${snake}.js'

describe('${snake} corrector', () => {
  it('returns unchanged data when nothing to correct', () => {
    const data = { summary: 'test' }
    const result = ${snake}(data, {})
    expect(result.corrected).toBe(false)
  })
})
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Implement packages/cambium-runner/src/correctors/${snake}.ts`);
  console.log(`  2. Register in packages/cambium-runner/src/correctors/index.ts: import and add to correctors map`);
  console.log(`  3. Declare in your agent: corrects :${snake}`);
}

// ── Dispatch ──────────────────────────────────────────────────────────

const GENERATORS = {
  agent: generateAgent,
  tool: generateTool,
  schema: generateSchema,
  system: generateSystem,
  corrector: generateCorrector,
  engine: generateEngine,
};

export function runGenerate(type, name) {
  if (!type || !name) {
    console.error(`\nUsage: cambium new <type> <Name>\n`);
    console.error(`Types: ${Object.keys(GENERATORS).join(', ')}\n`);
    console.error(`Examples:`);
    console.error(`  cambium new engine Summarizer       # new engine folder under ./cambium/`);
    console.error(`  cambium new agent BtcAnalyst        # new gen (engine sibling, or app/gens/)`);
    console.error(`  cambium new tool price_fetcher      # new tool (engine sibling, or app/tools/)`);
    console.error(`  cambium new schema TradeSignal      # add a TypeBox export`);
    console.error(`  cambium new system crypto_analyst   # add a system prompt`);
    console.error(`  cambium new corrector price_check   # add a framework corrector\n`);
    process.exit(2);
  }

  const gen = GENERATORS[type];
  if (!gen) {
    console.error(`Unknown type: ${type}. Available: ${Object.keys(GENERATORS).join(', ')}`);
    process.exit(2);
  }

  // The engine subcommand creates a folder; everything else needs an existing
  // context (engine-folder sibling or app workspace).
  const ctx = detectScaffoldContext(process.cwd());
  if (type !== 'engine' && ctx.mode === 'none') {
    noContextError();
  }

  gen(name, ctx);
}
