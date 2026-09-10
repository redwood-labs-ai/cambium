/**
 * #219: `enrich`'s sub-agent compile spawned `ruby ruby/cambium/compile.rb`
 * with `cwd: process.cwd()`, and `findAgentFile` looked for the sub-agent's
 * `.cmb.rb` under a hardcoded `packages/cambium/app/gens/` path also relative
 * to cwd. Together, any gen declaring `enrich` only worked when
 * `process.cwd()` was the Cambium monorepo root — and even then only for the
 * `[workspace]` layout, never a flat `[package]` app (RED-286), because the
 * `packages/cambium/` prefix was hardcoded rather than layout-aware.
 *
 * Drives the real CLI (same harness shape as `genfile_no_types.test.ts`) with
 * `cwd: scratch` — i.e. NOT the monorepo root — against both project shapes:
 *
 *   - a flat `[package]` scratch, sub-agent at `<scratch>/app/gens/`
 *     (this is the shape #219's acceptance criterion actually names: "An
 *     `enrich` gen runs from an external `[package]` workspace").
 *   - a `[workspace]` scratch mirroring the monorepo's own
 *     `packages/cambium/app/gens/` layout, so the existing in-tree
 *     convention every enrich gen in this repo relies on keeps working.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');

const SUB_SUMMARIZER = `
class SubSummarizer < GenModel
  model "omlx:stub"
  system "inline sub-agent system"
  returns do
    field :summary, String
  end
  def summarize(input)
    generate "summarize" do
      with context: input
    end
  end
end
`.trim();

const ENRICH_HOST = `
class EnrichHost < GenModel
  model "omlx:stub"
  system "inline host system"
  returns do
    field :summary, String
  end

  enrich :document do
    agent :SubSummarizer, method: :summarize
  end

  def analyze(document)
    generate "analyze" do
      with context: document
    end
  end
end
`.trim();

function runCli(scratch: string, args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: scratch, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

/** Run the host gen + assert the Enrich step compiled and completed, for
 *  whichever scratch/gensDir the caller already set up. Shared assertion
 *  body between the two project-shape tests below. */
function assertEnrichRunsClean(scratch: string, hostGenPath: string, docPath: string) {
  const tracePath = join(scratch, 'trace.json');
  const result = runCli(scratch, [
    'run', hostGenPath,
    '--method', 'analyze', '--arg', docPath,
    '--mock', '--trace', tracePath,
  ]);

  expect(result.status, (result.stderr ?? '') + (result.stdout ?? '')).toBe(0);

  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  const steps: any[] = trace.steps;

  // No EnrichError (agent file not found) and no EnrichCompileError (ruby
  // compile.rb spawn failed) — both the file-lookup and the compile-spawn
  // sides of #219 must resolve without depending on cwd.
  expect(steps.some((s) => s.type === 'EnrichError')).toBe(false);
  expect(steps.some((s) => s.type === 'EnrichCompileError')).toBe(false);

  const complete = steps.find((s) => s.type === 'EnrichComplete');
  expect(complete, JSON.stringify(steps)).toBeDefined();
  expect(complete.meta.field).toBe('document');
  expect(complete.meta.agent).toBe('SubSummarizer');

  const output = JSON.parse(result.stdout);
  expect(typeof output.summary).toBe('string');
}

describe('#219: enrich sub-agent resolution does not depend on process.cwd()', () => {
  describe('flat [package] shape (RED-286) — the shape the acceptance criterion names', () => {
    let scratch: string;
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'cambium-enrich-package-'));
      mkdirSync(join(scratch, 'app', 'gens'), { recursive: true });
      writeFileSync(join(scratch, 'Genfile.toml'), `[package]\nname = "enrichtest"\nversion = "0.0.0"\n`);
      writeFileSync(
        join(scratch, 'package.json'),
        JSON.stringify({ name: 'enrichtest', type: 'module', private: true }) + '\n',
      );
      writeFileSync(join(scratch, 'doc.txt'), 'raw log lines here\n');

      // Flat [package] layout: sub-agent sits alongside the host gen under
      // <scratch>/app/gens/ — no packages/cambium/ prefix anywhere.
      writeFileSync(join(scratch, 'app', 'gens', 'sub_summarizer.cmb.rb'), SUB_SUMMARIZER);
      writeFileSync(join(scratch, 'app', 'gens', 'enrich_host.cmb.rb'), ENRICH_HOST);
    });
    afterEach(() => {
      if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    });

    it('an enrich gen runs to completion from an external [package] workspace', () => {
      assertEnrichRunsClean(
        scratch,
        join(scratch, 'app', 'gens', 'enrich_host.cmb.rb'),
        join(scratch, 'doc.txt'),
      );
    });
  });

  describe('[workspace] shape (RED-286) — the monorepo layout every in-tree enrich gen uses', () => {
    let scratch: string;
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'cambium-enrich-workspace-'));
      mkdirSync(join(scratch, 'packages', 'cambium', 'app', 'gens'), { recursive: true });
      writeFileSync(join(scratch, 'Genfile.toml'), `[workspace]\nname = "enrichtestws"\nversion = "0.0.0"\n`);
      writeFileSync(
        join(scratch, 'package.json'),
        JSON.stringify({ name: 'enrichtestws', type: 'module', private: true }) + '\n',
      );
      writeFileSync(join(scratch, 'doc.txt'), 'raw log lines here\n');

      // [workspace] layout: both gens live under packages/cambium/app/gens/,
      // mirroring this repo's own packages/cambium/app/gens/ tree.
      writeFileSync(
        join(scratch, 'packages', 'cambium', 'app', 'gens', 'sub_summarizer.cmb.rb'),
        SUB_SUMMARIZER,
      );
      writeFileSync(
        join(scratch, 'packages', 'cambium', 'app', 'gens', 'enrich_host.cmb.rb'),
        ENRICH_HOST,
      );
    });
    afterEach(() => {
      if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    });

    it('an enrich gen runs to completion from a [workspace] scratch with cwd = workspace root (not the real monorepo root)', () => {
      assertEnrichRunsClean(
        scratch,
        join(scratch, 'packages', 'cambium', 'app', 'gens', 'enrich_host.cmb.rb'),
        join(scratch, 'doc.txt'),
      );
    });
  });
});
