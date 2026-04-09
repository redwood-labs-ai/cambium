#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PKG = 'packages/cambium';

// ── Helpers ───────────────────────────────────────────────────────────

function snakeCase(name) {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function pascalCase(name) {
  return name
    .replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase());
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

// ── Generators ────────────────────────────────────────────────────────

function generateAgent(name) {
  const snake = snakeCase(name);
  const pascal = pascalCase(name);
  const schemaName = `${pascal}Report`;

  console.log(`\nGenerating agent: ${pascal}\n`);

  writeFile(join(PKG, 'app/gens', `${snake}.cmb.rb`), `\
class ${pascal} < GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :${snake}
  temperature 0.2
  max_tokens 1200

  returns ${schemaName}

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

function generateTool(name) {
  const snake = snakeCase(name);

  console.log(`\nGenerating tool: ${snake}\n`);

  writeFile(join(PKG, 'app/tools', `${snake}.tool.json`), JSON.stringify({
    name: snake,
    description: `TODO: describe what ${snake} does`,
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'string' },
      },
    },
  }, null, 2) + '\n');

  writeFile(join('src/tools', `${snake}.ts`), `\
export function execute(input: { input: string }): { result: string } {
  // TODO: implement ${snake}
  return { result: input.input };
}
`);

  writeFile(join('src/tools', `${snake}.test.ts`), `\
import { describe, it, expect } from 'vitest'
import { execute } from './${snake}.js'

describe('${snake}', () => {
  it('executes', () => {
    const result = execute({ input: 'test' })
    expect(result).toHaveProperty('result')
  })
})
`);

  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${PKG}/app/tools/${snake}.tool.json (input/output schemas)`);
  console.log(`  2. Implement src/tools/${snake}.ts`);
  console.log(`  3. Register in src/tools/index.ts: import and add to builtinTools`);
  console.log(`  4. Declare in your agent: uses :${snake}`);
}

function generateSchema(name) {
  const pascal = pascalCase(name);

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

function generateSystem(name) {
  const snake = snakeCase(name);

  console.log(`\nGenerating system prompt: ${snake}\n`);

  writeFile(join(PKG, 'app/systems', `${snake}.system.md`), `\
You are a ${snake.replace(/_/g, ' ')}. TODO: describe the role, expertise, and behavioral expectations.`);

  console.log(`\nUse in your agent: system :${snake}`);
}

function generateCorrector(name) {
  const snake = snakeCase(name);

  console.log(`\nGenerating corrector: ${snake}\n`);

  writeFile(join('src/correctors', `${snake}.ts`), `\
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
  };
};
`);

  writeFile(join('src/correctors', `${snake}.test.ts`), `\
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
  console.log(`  1. Implement src/correctors/${snake}.ts`);
  console.log(`  2. Register in src/correctors/index.ts: import and add to correctors map`);
  console.log(`  3. Declare in your agent: corrects :${snake}`);
}

// ── Dispatch ──────────────────────────────────────────────────────────

const GENERATORS = {
  agent: generateAgent,
  tool: generateTool,
  schema: generateSchema,
  system: generateSystem,
  corrector: generateCorrector,
};

export function runGenerate(type, name) {
  if (!type || !name) {
    console.error(`\nUsage: cambium new <type> <Name>\n`);
    console.error(`Types: ${Object.keys(GENERATORS).join(', ')}\n`);
    console.error(`Examples:`);
    console.error(`  cambium new agent BtcAnalyst`);
    console.error(`  cambium new tool price_fetcher`);
    console.error(`  cambium new schema TradeSignal`);
    console.error(`  cambium new system crypto_analyst`);
    console.error(`  cambium new corrector price_validation\n`);
    process.exit(2);
  }

  const gen = GENERATORS[type];
  if (!gen) {
    console.error(`Unknown type: ${type}. Available: ${Object.keys(GENERATORS).join(', ')}`);
    process.exit(2);
  }

  gen(name);
}
