import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenFromIr } from './runner.js';

// RED-393 — App-root resolution is single-sourced.
//
// The recurring Docker/CI/run-from-anywhere bug class: contracts loaded from
// the gen's own workspace (anchored on `ir.entry.source`) while app PLUGINS
// (tools/actions/providers/log sinks) loaded from `process.cwd()`. When cwd
// diverges from the gen's workspace, plugin discovery silently misses.
//
// This test proves a custom `app/providers/<name>.ts` is discovered from the
// GEN'S workspace even when the run's cwd points at an unrelated directory —
// the only way the run can succeed is if provider discovery anchored on
// entry.source, not cwd. The canned provider returns valid JSON so the run
// completes without contacting any real model backend (no --mock needed; the
// provider IS the backend).

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPILE_RB = resolve(__dirname, '../../..', 'ruby/cambium/compile.rb');

const CONTRACTS = `
export const Out = { $id: 'Out', type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
`;

const GEN = `
class Echo < GenModel
  model "canned:x"
  returns Out

  def run(input)
    generate "echo the input" do
      returns Out
    end
  end
end
`;

const GENFILE = `
[package]
name = "wsb"
version = "0.0.0"

[types]
contracts = ["contracts.ts"]
`;

const PROVIDER = `
export default {
  name: 'canned',
  supportsDocuments: false,
  async generateText() {
    return { text: JSON.stringify({ answer: 'from canned provider' }) };
  },
  async generateWithTools() {
    return { message: { content: JSON.stringify({ answer: 'from canned provider' }) } };
  },
};
`;

let wsGen: string; // the gen's workspace (has the custom provider)
let wsCwd: string; // an unrelated cwd (no provider)

beforeEach(() => {
  wsGen = mkdtempSync(join(tmpdir(), 'cambium-wsgen-'));
  mkdirSync(join(wsGen, 'app/gens'), { recursive: true });
  mkdirSync(join(wsGen, 'app/providers'), { recursive: true });
  writeFileSync(join(wsGen, 'Genfile.toml'), GENFILE);
  writeFileSync(join(wsGen, 'contracts.ts'), CONTRACTS);
  writeFileSync(join(wsGen, 'app/gens/echo.cmb.rb'), GEN);
  writeFileSync(join(wsGen, 'app/providers/canned.ts'), PROVIDER);
  wsCwd = mkdtempSync(join(tmpdir(), 'cambium-wscwd-'));
});
afterEach(() => {
  rmSync(wsGen, { recursive: true, force: true });
  rmSync(wsCwd, { recursive: true, force: true });
});

function compileEcho(): any {
  const r = spawnSync('ruby', [COMPILE_RB, join(wsGen, 'app/gens/echo.cmb.rb'), '--method', 'run'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env },
  });
  if (r.status !== 0) throw new Error(`compile failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('app-root invariant: provider discovery follows the gen workspace, not cwd', () => {
  it('discovers app/providers/<name>.ts from the gen workspace when cwd is elsewhere', async () => {
    const ir = compileEcho();
    // entry.source points into wsGen; cwd is the unrelated wsCwd. If discovery
    // used cwd, "canned" would be unknown and generate would throw.
    const result = await runGenFromIr({
      ir,
      cwd: wsCwd,
      traceOut: join(wsCwd, 'trace.json'),
      outputOut: join(wsCwd, 'output.json'),
    });
    expect((result.output as any).answer).toBe('from canned provider');
  });

  it('explicit appRoot still wins over the entry.source anchor', async () => {
    const ir = compileEcho();
    // Point appRoot at wsGen explicitly while cwd is wsCwd — same success,
    // proving the RED-391 explicit-override path composes with the new anchor.
    const result = await runGenFromIr({
      ir,
      cwd: wsCwd,
      appRoot: wsGen,
      traceOut: join(wsCwd, 'trace.json'),
      outputOut: join(wsCwd, 'output.json'),
    });
    expect((result.output as any).answer).toBe('from canned provider');
  });
});
