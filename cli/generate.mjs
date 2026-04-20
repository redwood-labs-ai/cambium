#!/usr/bin/env node
import { writeFileSync, appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import process from 'node:process';
import { detectWorkspaceShape } from './workspace-shape.mjs';

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

// ── Mode detection (RED-246, layout-aware RED-286) ────────────────────
//
// `cambium new <thing>` needs to know whether it's authoring inside an
// engine folder (sibling-of-gen layout, no `app/<type>/` subdirs) or an
// app-mode workspace (the conventional `app/<type>/<name>` layout). The
// decision is filesystem-driven so a single function works for every
// subcommand.
//
// Sentinel walk (phase 1) stops at the first `package.json` to avoid
// leaking out of an embedded engine into a parent project. The app-mode
// walk (phase 2) uses `detectWorkspaceShape` so both monorepo
// ([workspace] members = ["packages/*"], cambium's own layout) and flat
// ([package] at project root, e.g. the curator dogfood) projects
// resolve the right appPkgRoot.
//
// Returns:
//   { mode: 'engine', engineDir }
//   { mode: 'app', workspaceRoot, appPkgRoot, shape: 'workspace'|'package' }
//   { mode: 'none' }

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

  // Phase 2: no sentinel — try app-mode markers via shape detection.
  // No boundary check; walking up through the host project is fine.
  const shape = detectWorkspaceShape(cwd);
  if (shape) {
    return {
      mode: 'app',
      workspaceRoot: shape.workspaceRoot,
      appPkgRoot: shape.appPkgRoot,
      shape: shape.shape,
    };
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
  const PKG = ctx.appPkgRoot;
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
    console.log(`\n  Default permissions are 'pure: true'. If you add ctx.fetch, fs, or exec calls`);
    console.log(`  to the handler, update the .tool.json permissions block FIRST — the static check`);
    console.log(`  reads the JSON, not the TS body, and a lying 'pure: true' silently bypasses it.`);
    return;
  }

  // App mode. External apps (shape === 'package') import ToolContext
  // from the published @cambium/runner package; the in-tree cambium
  // workspace (shape === 'workspace') uses a deep relative to the
  // framework source since it doesn't import itself as a package.
  const PKG = ctx.appPkgRoot;
  const toolContextImport = ctx.shape === 'workspace'
    ? '../../../cambium-runner/src/tools/tool-context.js'
    : '@cambium/runner';
  writeFile(join(PKG, 'app/tools', `${snake}.tool.json`), toolJson);
  writeFile(join(PKG, 'app/tools', `${snake}.tool.ts`), `\
/**
 * Plugin tool handler. Auto-discovered alongside ${snake}.tool.json (RED-209).
 *
 * If this tool needs network access, declare it in the .tool.json
 * permissions block and use \`ctx.fetch\` here — NOT globalThis.fetch
 * (the SSRF guard lives on ctx.fetch; direct fetch bypasses it).
 */
import type { ToolContext } from '${toolContextImport}';

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
  console.log(`\n  Default permissions are 'pure: true'. If you add ctx.fetch, fs, or exec calls`);
  console.log(`  to the handler, update the .tool.json permissions block FIRST — the static check`);
  console.log(`  reads the JSON, not the TS body, and a lying 'pure: true' silently bypasses it.`);
  console.log(`\nTip: try \`cambium new tool --describe "what it does"\` for an agentic scaffolder`);
  console.log(`     that infers the schema and permissions from a natural-language description.`);
}

function generateSchema(name, ctx) {
  validateName(name, 'schema name');
  const pascal = pascalCase(name);

  if (ctx.mode === 'engine') {
    // RED-289: engine-mode owns `schemas.ts` as an editable sibling of
    // the gen, so the scaffolder can append the export directly
    // instead of just printing instructions. Idempotent — skips with a
    // "exists" note if the export is already in the file.
    const schemasPath = join(ctx.engineDir, 'schemas.ts');
    const exportBlock = `
export const ${pascal} = Type.Object(
  {
    // TODO: define fields
    summary: Type.String(),
  },
  { additionalProperties: false, $id: '${pascal}' },
);
`;

    console.log(`\nGenerating schema: ${pascal}\n`);

    if (!existsSync(schemasPath)) {
      // No schemas.ts yet — scaffold a fresh file with the TypeBox
      // import and the new export. Every subsequent `cambium new schema`
      // will append to this file. Route through writeFile (not bare
      // writeFileSync) so the overwrite-protection invariant holds on
      // every code path — security review flagged a TOCTOU gap here.
      writeFile(schemasPath, `import { Type } from '@sinclair/typebox';\n${exportBlock}`);
    } else {
      const existing = readFileSync(schemasPath, 'utf8');
      const alreadyPresent = new RegExp(`^\\s*export\\s+const\\s+${pascal}\\b`, 'm').test(existing);
      if (alreadyPresent) {
        console.log(`  exists: ${pascal} is already exported from ${schemasPath} (skipped)`);
      } else {
        const needsNewline = existing.length > 0 && !existing.endsWith('\n');
        appendFileSync(schemasPath, `${needsNewline ? '\n' : ''}${exportBlock}`);
        console.log(`  appended: ${pascal} → ${schemasPath}`);
      }
    }

    console.log(`\nNext step: use in your gen → returns ${pascal}`);
    return;
  }

  const PKG = ctx.appPkgRoot;
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
    : join(ctx.appPkgRoot, 'app/systems');

  writeFile(join(dir, `${snake}.system.md`), `\
You are a ${snake.replace(/_/g, ' ')}. TODO: describe the role, expertise, and behavioral expectations.`);

  console.log(`\nUse in your agent: system :${snake}`);
}

function generateCorrector(name, ctx) {
  validateName(name, 'corrector name');

  // RED-275 app-level correctors: `app/correctors/<snake>.corrector.ts`
  // exporting a function named matching the basename. Auto-discovered
  // by the runner at startup — no registration step. Basename must
  // match /^[a-z][a-z0-9_]*$/ (enforced by the loader); validateName's
  // regex is stricter (starts with A-Z) so the snake_case conversion
  // below keeps us inside the loader's allowed set.

  const snake = snakeCase(name);

  // Extra guard: the app-corrector loader regex is /^[a-z][a-z0-9_]*$/.
  // snakeCase(validatedName) already produces a matching string for
  // any input validateName accepts, but assert defensively in case
  // the conversion ever drifts.
  if (!/^[a-z][a-z0-9_]*$/.test(snake)) {
    console.error(`Corrector basename "${snake}" must match /^[a-z][a-z0-9_]*$/ (RED-275).`);
    process.exit(2);
  }

  // Import path differs by mode to match existing scaffolder conventions:
  //   - engine mode imports from the @cambium/runner npm package.
  //   - in-tree app mode uses a deep relative path to the framework
  //     correctors/types.ts (same stance generateTool takes for
  //     ToolContext). External apps with their own Genfile + flat
  //     layout will want @cambium/runner; that layout isn't supported
  //     by the app-mode scaffolder today — see the CLI-parity-audit
  //     ticket's layout-flexibility follow-up.
  const makeBody = (typeImport) => `\
/**
 * App-level corrector plugin (RED-275). Auto-discovered by the runner
 * at startup when the file lives under \`app/correctors/\` with the
 * \`.corrector.ts\` suffix and exports a function matching the basename.
 *
 * Return \`corrected: true\` with an updated \`output\` when the
 * corrector can deterministically fix the data (math recompute, date
 * normalization, etc.). Return \`corrected: false\` with
 * \`severity: 'error'\` issues when the data fails a domain check the
 * corrector can verify but not auto-fix (e.g. "regex compiles and
 * matches its own test cases") — those issues feed the repair loop,
 * giving the LLM a shot at producing something better.
 */
import type { CorrectorFn, CorrectorResult, CorrectorIssue } from '${typeImport}';

export const ${snake}: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);

  // TODO: implement ${snake}

  return {
    corrected: issues.some(i => i.severity === 'fixed'),
    output,
    issues,
  };
};
`;

  if (ctx.mode === 'engine') {
    // Engine mode: sibling of the engine's gens. Same auto-discovery
    // semantics once the runner's discovery walk is engine-aware; today
    // app-mode is the primary target.
    writeFile(join(ctx.engineDir, `${snake}.corrector.ts`), makeBody('@cambium/runner'));
    console.log(`\nNext steps:`);
    console.log(`  1. Implement ${ctx.engineDir}/${snake}.corrector.ts`);
    console.log(`  2. Declare in your gen: corrects :${snake}`);
    return;
  }

  // App mode. External apps (shape === 'package') import CorrectorFn
  // et al. from @cambium/runner; in-tree cambium workspace
  // (shape === 'workspace') uses the deep relative to framework source.
  const PKG = ctx.appPkgRoot;
  const correctorTypeImport = ctx.shape === 'workspace'
    ? '../../../cambium-runner/src/correctors/types.js'
    : '@cambium/runner';
  writeFile(
    join(PKG, 'app/correctors', `${snake}.corrector.ts`),
    makeBody(correctorTypeImport),
  );

  console.log(`\nNext steps:`);
  console.log(`  1. Implement ${PKG}/app/correctors/${snake}.corrector.ts`);
  console.log(`  2. Declare in your agent: corrects :${snake}`);
  console.log(`\n  The file is auto-discovered — no registration step needed.`);
  console.log(`  Overrides any framework built-in with the same name (with a one-time stderr warning).`);
}

// ── Action scaffolder (RED-212, added RED-284) ────────────────────────

function generateAction(name, ctx) {
  validateName(name, 'action name');
  const snake = snakeCase(name);

  const actionJson = JSON.stringify({
    name: snake,
    description: `TODO: describe what the ${snake} action does when a trigger fires`,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Signal payload or literal text.' },
      },
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'string', description: 'A short summary of what the action did.' },
      },
      additionalProperties: false,
    },
    permissions: { pure: true },
  }, null, 2) + '\n';

  const makeBody = (ctxTypeImport) => `\
/**
 * Plugin action handler (RED-212). Auto-discovered alongside
 * ${snake}.action.json. Called by the trigger dispatcher when an
 * \`on :signal do; action :${snake}, ... ; end\` fires.
 *
 * If this action needs network access, declare it in the .action.json
 * permissions block and use \`ctx.fetch\` — NOT globalThis.fetch
 * (the SSRF guard lives on ctx.fetch; direct fetch bypasses it).
 */
import type { ToolContext } from '${ctxTypeImport}';

export async function execute(
  input: any,
  _ctx?: ToolContext,
): Promise<{ value: string }> {
  // TODO: implement ${snake}
  return { value: String(input?.message ?? '') };
}
`;

  if (ctx.mode === 'engine') {
    writeFile(join(ctx.engineDir, `${snake}.action.json`), actionJson);
    writeFile(join(ctx.engineDir, `${snake}.action.ts`), makeBody('@cambium/runner'));
    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${ctx.engineDir}/${snake}.action.json — schemas + permissions`);
    console.log(`  2. Implement ${ctx.engineDir}/${snake}.action.ts`);
    console.log(`  3. Wire a trigger: on :signal_name do; action :${snake}, message: "..." ; end`);
    return;
  }

  const PKG = ctx.appPkgRoot;
  const toolContextImport = ctx.shape === 'workspace'
    ? '../../../cambium-runner/src/tools/tool-context.js'
    : '@cambium/runner';
  writeFile(join(PKG, 'app/actions', `${snake}.action.json`), actionJson);
  writeFile(
    join(PKG, 'app/actions', `${snake}.action.ts`),
    makeBody(toolContextImport),
  );

  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${PKG}/app/actions/${snake}.action.json — schemas + permissions`);
  console.log(`  2. Implement ${PKG}/app/actions/${snake}.action.ts`);
  console.log(`  3. Wire a trigger: on :signal_name do; action :${snake}, ... ; end`);
  console.log(`\n  Default permissions are 'pure: true'. If you add ctx.fetch / fs / exec calls,`);
  console.log(`  update the .action.json permissions block FIRST — the static check reads the`);
  console.log(`  JSON, not the TS body.`);
}

// ── Policy pack scaffolder (RED-214, added RED-284) ───────────────────

function generatePolicy(name, ctx) {
  validateName(name, 'policy name');
  const snake = snakeCase(name);

  // RED-214 policy-pack filename regex.
  if (!/^[a-z][a-z0-9_]*$/.test(snake)) {
    console.error(`Policy pack name "${snake}" must match /^[a-z][a-z0-9_]*$/ (RED-214).`);
    process.exit(2);
  }

  const policyBody = `\
# RED-214 policy pack: reusable security + budget bundle.
#
# A gen pulls this in by symbol:
#
#   security :${snake}     # applies the network/filesystem/exec slots below
#   budget   :${snake}     # applies the per_tool / per_run slots below
#
# The gen can mix slots across packs + inline — each slot
# (network / filesystem / exec / per_tool / per_run) must be set by
# exactly one source. Inline keyword form + pack symbol in the same
# call is rejected.

# Uncomment + customize one or more blocks. Any block left out stays
# at its framework default (deny-by-default for network; no exec; etc.).

# network \\
#   allowlist: %w[api.example.com],
#   block_private: true,
#   block_metadata: true

# filesystem \\
#   allowlist_paths: %w[/data/in /tmp/cambium]

# exec \\
#   runtime: :wasm,          # :wasm | :firecracker | :native (deprecated)
#   language: :javascript,
#   timeout: 30,
#   memory: 256

# budget \\
#   per_tool: { web_search: { max_calls: 5 } },
#   per_run:  { max_calls: 20, max_tokens: 20_000 }
`;

  if (ctx.mode === 'engine') {
    console.error(`\n'cambium new policy' is not supported in engine mode.`);
    console.error(`Policy packs live at the workspace level — engines pull in workspace packs by symbol.`);
    process.exit(2);
  }

  const PKG = ctx.appPkgRoot;
  writeFile(join(PKG, 'app/policies', `${snake}.policy.rb`), policyBody);

  console.log(`\nNext steps:`);
  console.log(`  1. Uncomment + customize the security/budget blocks in ${PKG}/app/policies/${snake}.policy.rb`);
  console.log(`  2. Reference by symbol in a gen: security :${snake} (and/or budget :${snake})`);
  console.log(`\n  Name must match /^[a-z][a-z0-9_]*$/ — enforced at both scaffold time and`);
  console.log(`  PolicyPack.load to prevent path traversal via symbol.`);
}

// ── Memory pool scaffolder (RED-215, added RED-284) ───────────────────

function generateMemoryPool(name, ctx) {
  validateName(name, 'memory pool name');
  const snake = snakeCase(name);

  // RED-215 memory-pool filename regex.
  if (!/^[a-z][a-z0-9_]*$/.test(snake)) {
    console.error(`Memory pool name "${snake}" must match /^[a-z][a-z0-9_]*$/ (RED-215).`);
    process.exit(2);
  }

  const poolBody = `\
# RED-215 memory pool: authoritative strategy + embed + keyed_by for one
# or more gens that opt in via \`memory :<slot>, scope: :${snake}, ...\`.
#
# The gen at the use site can only set reader knobs (size / top_k).
# Strategy, embed, keyed_by, retain all come from here.

# Pick ONE strategy:
#   :sliding_window — last N entries, cheap, no embeddings
#   :semantic       — vec-search against ctx.input; requires embed
#   :log            — append-only; no read-inject into prompts
strategy :sliding_window

# Only required for :semantic:
# embed "omlx:bge-small-en"

# Scope key required at run time (cambium run --memory-key <key>=<value>).
# Omit for "singleton" pools where every gen shares one bucket.
# keyed_by :team_id

# Retention (RED-239). Optional; the workspace's memory_policy.rb may
# enforce a max_ttl.
# retain ttl: "30d", max_entries: 1000
`;

  if (ctx.mode === 'engine') {
    console.error(`\n'cambium new memory_pool' is not supported in engine mode.`);
    console.error(`Memory pools live at the workspace level — engines pull in workspace pools by symbol.`);
    process.exit(2);
  }

  const PKG = ctx.appPkgRoot;
  writeFile(join(PKG, 'app/memory_pools', `${snake}.pool.rb`), poolBody);

  console.log(`\nNext steps:`);
  console.log(`  1. Pick the strategy + embed (for :semantic) in ${PKG}/app/memory_pools/${snake}.pool.rb`);
  console.log(`  2. Reference from a gen: memory :<slot>, scope: :${snake}, top_k: 5`);
  console.log(`\n  Name must match /^[a-z][a-z0-9_]*$/ — enforced at both scaffold time and`);
  console.log(`  MemoryPool.load to prevent path traversal via symbol.`);
}

// ── Config scaffolder (RED-237 + RED-239, added RED-284) ──────────────
//
// `cambium new config models`          → app/config/models.rb (RED-237)
// `cambium new config memory_policy`   → app/config/memory_policy.rb (RED-239)
//
// "name" here is the form (`models` or `memory_policy`), not an
// identifier the user picks. Kept under `cambium new <type> <form>` for
// consistency with how everything else dispatches.

function generateConfig(name, ctx) {
  const validForms = ['models', 'memory_policy'];
  if (!validForms.includes(name)) {
    console.error(`\nUsage: cambium new config <form>`);
    console.error(`Forms: ${validForms.join(', ')}`);
    console.error(`  models          — app/config/models.rb (RED-237 aliases)`);
    console.error(`  memory_policy   — app/config/memory_policy.rb (RED-239 governance)`);
    process.exit(2);
  }

  if (ctx.mode === 'engine') {
    console.error(`\n'cambium new config' is not supported in engine mode.`);
    console.error(`Config files live at the workspace level.`);
    process.exit(2);
  }

  const PKG = ctx.appPkgRoot;
  const dest = join(PKG, 'app/config', `${name}.rb`);

  if (name === 'models') {
    writeFile(dest, `\
# RED-237: workspace-configurable model aliases.
#
# Maps symbolic names to literal provider:model ids. Gens reference
# these by symbol (\`model :default\`, \`embed: :embedding\`); the
# compiler resolves to literals before emitting IR, so the runner
# always sees concrete ids.
#
# Names must match /^[a-z][a-z0-9_]*$/. Values must be literal
# provider-prefixed ids (contain ':').

default   "omlx:Qwen3.5-27B-4bit"
# fast      "omlx:gemma-4-31b-it-8bit"
# embedding "omlx:bge-small-en"
`);

    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${dest} to add aliases your gens can reference via :symbol.`);
    console.log(`  2. Use in a gen: model :default`);
    return;
  }

  // memory_policy
  writeFile(dest, `\
# RED-239: workspace-level memory governance.
#
# Enforced at compile time — any gen whose memory decls violate the
# policy fails with a CompileError naming the offending decl and policy
# file. Loaded from app/config/memory_policy.rb (RED-245 search paths).

# Cap the retention TTL any single memory decl or pool can declare.
# Bounded by MAX_TTL_SECONDS = 10 years.
# max_ttl "90d"

# Default TTL applied when a decl / pool leaves retain.ttl unset.
# Must be <= max_ttl (validated at policy load).
# default_ttl "7d"

# Cap on max_entries per bucket.
# max_entries 10_000

# Ban a scope outright (reject any gen using it). Common: :global.
# ban_scope :global

# Require a keyed_by value for specific scopes. Prevents bucket collisions
# when many users share an app.
# require_keyed_by_for session: :user_id

# Optional whitelist of pool names the workspace permits. When set, any
# gen referencing a pool outside this list fails compile.
# allowed_pools :support_team
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Uncomment + customize the directives in ${dest}.`);
  console.log(`  2. Re-run your gens — policy is checked at compile time; violators fail fast.`);
}

// ── Dispatch ──────────────────────────────────────────────────────────

const GENERATORS = {
  agent: generateAgent,
  tool: generateTool,
  action: generateAction,
  schema: generateSchema,
  system: generateSystem,
  corrector: generateCorrector,
  policy: generatePolicy,
  memory_pool: generateMemoryPool,
  config: generateConfig,
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
    console.error(`  cambium new action slack_notify     # new trigger action (RED-212)`);
    console.error(`  cambium new schema TradeSignal      # add a TypeBox export`);
    console.error(`  cambium new system crypto_analyst   # add a system prompt`);
    console.error(`  cambium new corrector regex_check   # add an app corrector (RED-275)`);
    console.error(`  cambium new policy research_caps    # add a security+budget pack (RED-214)`);
    console.error(`  cambium new memory_pool support     # add a memory pool (RED-215)`);
    console.error(`  cambium new config models           # add app/config/models.rb (RED-237)`);
    console.error(`  cambium new config memory_policy    # add app/config/memory_policy.rb (RED-239)\n`);
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
