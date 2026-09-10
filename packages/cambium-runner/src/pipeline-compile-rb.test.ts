/**
 * #242: integration-level proof that `runPipelineFromIr` consumes the
 * shared `resolveCompileRb` chain (`compile-rb.ts`) — specifically the
 * `CAMBIUM_COMPILE_RB` env-var and explicit-param links `pipeline.ts`
 * lacked before this change (its own `resolveDefaultCompileRb` helper
 * only implemented the createRequire-sibling + dev-fallback links).
 *
 * A minimal `Pipeline` IR is enough: `runPipelineFromIr` resolves and
 * validates `compileRb` before doing any operator work, so a bogus path
 * fails fast with a message that names the path it tried — proof of
 * which link fired, without needing a real pipeline/gen fixture.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipelineFromIr } from './pipeline.js';

const MINIMAL_PIPELINE_IR: any = {
  kind: 'Pipeline',
  version: '1',
  entry: { class: 'TestPipeline', method: 'run' },
  policies: {},
  operators: [],
};

describe('runPipelineFromIr — compileRb precedence (#242)', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cambium-pipeline-compilerb-'));
    prevEnv = process.env.CAMBIUM_COMPILE_RB;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CAMBIUM_COMPILE_RB;
    else process.env.CAMBIUM_COMPILE_RB = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('honors CAMBIUM_COMPILE_RB when opts.compileRb is unset (the link pipeline.ts lacked pre-#242)', async () => {
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.pipeline-env';
    await expect(
      runPipelineFromIr({ ir: MINIMAL_PIPELINE_IR, cwd: tmp }),
    ).rejects.toThrow(/compile\.rb\.pipeline-env/);
  });

  it('opts.compileRb (explicit) wins over CAMBIUM_COMPILE_RB', async () => {
    process.env.CAMBIUM_COMPILE_RB = '/nonexistent/compile.rb.env';
    await expect(
      runPipelineFromIr({
        ir: MINIMAL_PIPELINE_IR,
        cwd: tmp,
        compileRb: '/nonexistent/compile.rb.explicit',
      }),
    ).rejects.toThrow(/compile\.rb\.explicit/);
  });
});
