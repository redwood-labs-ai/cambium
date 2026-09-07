// Guard against running the CLI against a stale `packages/cambium-runner/dist`.
//
// Every case builds a synthetic runner root in a tmpdir. The real tree is
// never touched on purpose: `checkRunnerFreshness` keys on src/dist mtimes,
// so touching the actual src/ mid-suite would trip the guard for every
// later test that shells out to cli/cambium.mjs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — plain .mjs CLI module, no type declarations
import { checkRunnerFreshness } from '../../../cli/runner-freshness.mjs';

const SKIP_ENV = 'CAMBIUM_SKIP_BUILD_CHECK';

let root: string;
let previousSkip: string | undefined;

/** Sets an absolute mtime so ordering is explicit rather than write-order luck. */
function stamp(path: string, epochSeconds: number) {
  utimesSync(path, epochSeconds, epochSeconds);
}

function writeSrc(rel: string, at: number, body = '// x\n') {
  const full = join(root, 'src', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  stamp(full, at);
  return full;
}

function writeDist(rel: string, at: number, body = '// x\n') {
  const full = join(root, 'dist', rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  stamp(full, at);
  return full;
}

/** Marks the tree as a source checkout — without this the guard no-ops. */
function makeSourceCheckout() {
  writeFileSync(join(root, 'tsconfig.build.json'), '{}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cambium-freshness-'));
  previousSkip = process.env[SKIP_ENV];
  delete process.env[SKIP_ENV];
});

afterEach(() => {
  if (previousSkip === undefined) delete process.env[SKIP_ENV];
  else process.env[SKIP_ENV] = previousSkip;
  rmSync(root, { recursive: true, force: true });
});

describe('checkRunnerFreshness', () => {
  it('passes when dist is newer than src', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 1000);
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toBeNull();
  });

  it('flags a stale dist and names the newer source file', () => {
    makeSourceCheckout();
    writeSrc('providers/anthropic.ts', 3000);
    writeDist('providers/anthropic.js', 2000);

    const msg = checkRunnerFreshness(root);
    expect(msg).toContain('stale');
    expect(msg).toContain(join('src', 'providers', 'anthropic.ts'));
    expect(msg).toContain('npm run build');
  });

  it('reports the branch dist was built from, which is the case that misleads', () => {
    // The bite: `npm test` rebuilds dist, so a stash/test/pop (or rebase, or
    // bisect) leaves dist holding another branch's code while the working
    // tree shows yours. Naming the branch is what distinguishes that from a
    // plain forgotten rebuild.
    makeSourceCheckout();
    writeSrc('runner.ts', 3000);
    writeDist('runner.js', 2000);
    writeDist(
      'build-info.json',
      2000,
      JSON.stringify({ branch: 'main', head: 'f75d1ac', dirty: false }),
    );

    expect(checkRunnerFreshness(root)).toContain('built from main@f75d1ac');
  });

  it('omits the provenance line when the stamp is absent (pre-guard build)', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 3000);
    writeDist('runner.js', 2000);

    const msg = checkRunnerFreshness(root);
    expect(msg).toContain('stale');
    expect(msg).not.toContain('built from');
  });

  it('flags a missing dist entirely', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 1000);
    expect(checkRunnerFreshness(root)).toContain('has not been built');
  });

  it('flags a dist directory that holds no emitted JS', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 1000);
    writeDist('notes.txt', 2000);
    expect(checkRunnerFreshness(root)).toContain('has not been built');
  });

  it('ignores runner test files — they are excluded from the build', () => {
    // tsconfig.build.json excludes *.test.ts, so editing one changes nothing
    // about dist. Demanding a rebuild there would be a pure false positive.
    makeSourceCheckout();
    writeSrc('runner.ts', 1000);
    writeSrc('runner.test.ts', 9000);
    writeSrc('agentic.regression.test.ts', 9000);
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toBeNull();
  });

  it('ignores __fixtures__, which copy-assets never ships', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 1000);
    writeSrc(join('__fixtures__', 'sample.json'), 9000);
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toBeNull();
  });

  it('counts copied assets (.json, .mjs) as build inputs', () => {
    // copy-assets.mjs ships these into dist/, so a newer one really does
    // mean dist is behind.
    makeSourceCheckout();
    writeSrc('tools/search.tool.json', 9000);
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toContain('stale');
  });

  it('no-ops outside a source checkout, so installed users are never gated', () => {
    // Published tarball: dist only, no src/ and no tsconfig.build.json.
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toBeNull();
  });

  it('honors the CAMBIUM_SKIP_BUILD_CHECK escape hatch', () => {
    makeSourceCheckout();
    writeSrc('runner.ts', 3000);
    writeDist('runner.js', 2000);
    expect(checkRunnerFreshness(root)).toContain('stale');

    process.env[SKIP_ENV] = '1';
    expect(checkRunnerFreshness(root)).toBeNull();
  });
});
