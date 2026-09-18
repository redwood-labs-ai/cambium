/**
 * #199: unit tests for `cambium promote`'s pure/file-local helpers,
 * imported directly from cli/promote.mjs (same convention
 * scaffolder_engine_mode.test.ts uses for cli/generate.mjs). The
 * end-to-end battery (promote_e2e.test.ts) drives the real CLI; this
 * file pins the deterministic decision logic in isolation:
 *   - DEC-006 run-ref resolution guard (traversal, malformed ids, path form)
 *   - DEC-002 context-key selection + extension sniff
 *   - DEC-008 preflight (all-or-nothing)
 *   - DEC-004 test-wiring cases 2 (placeholder replace) and 3 (no-touch),
 *     against fabricated test file content in a tmpdir.
 *   - DEC-010 (fix round 2): the whole consumed ir.json field surface is
 *     UNTRUSTED input, validated fail-closed before any use — traversal-
 *     shaped entry.class/entry.method (AUD-001/cambium-security), an
 *     out-of-workspace entry.source (AUD-001's own PoC shape), and a
 *     stale/absent entry.source.
 *   - DEC-011: `wireTest`'s GEN-line mismatch reporting.
 *   - DEC-012 (fix round 3): `goldenTestSource` emits GEN/FIXTURE/SNAPSHOT
 *     via JSON.stringify — a quote/backtick/${ in genRel/fixtureRel must
 *     round-trip safely, never break out of the generated literal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PromoteError,
  computeTargets,
  preflight,
  readIr,
  resolveFixtureContent,
  resolveRunDir,
  resolveScaffoldContext,
  selectContextKey,
  sniffExtension,
  wireTest,
} from '../../../cli/promote.mjs';

let scratch: string;
beforeEach(() => {
  // realpath: promote resolves real paths, and on macOS tmpdir() sits
  // under the /var -> /private/var symlink, so an unresolved scratch
  // never equals what it returns.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cambium-promote-unit-')));
});
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function writeRunDir(dir: string, ir: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ir.json'), JSON.stringify(ir));
}

const GEN_IR = {
  entry: { class: 'Analyst', method: 'analyze', source: 'packages/cambium/app/gens/analyst.cmb.rb' },
  context: { document: 'hello world' },
  steps: [],
};

const PIPELINE_IR = {
  kind: 'Pipeline',
  entry: { class: 'SamplePipeline', method: 'review', source: 'packages/cambium/app/pipelines/sample_pipeline.pipeline.rb' },
  operators: [],
};

// ── DEC-006: run-ref resolution guard ──────────────────────────────────

describe('resolveRunDir (DEC-006)', () => {
  it('resolves a well-formed bare id under <cwd>/runs/', () => {
    const runDir = join(scratch, 'runs', 'run_20260910_143902_ab12cd');
    writeRunDir(runDir, GEN_IR);
    expect(resolveRunDir('run_20260910_143902_ab12cd', scratch)).toBe(runDir);
  });

  it('rejects a malformed bare id BEFORE any join (never touches the filesystem)', () => {
    expect(() => resolveRunDir('not_a_run_id', scratch)).toThrow(/Invalid run id/);
    expect(() => resolveRunDir('run_2026_143902_ab12cd', scratch)).toThrow(/Invalid run id/); // date too short
    expect(() => resolveRunDir('run_20260910_143902_ZZZZZZ', scratch)).toThrow(/Invalid run id/); // not hex
    expect(() => resolveRunDir('run_20260910_143902_ab12cd_extra', scratch)).toThrow(/Invalid run id/);
  });

  it('path form (contains "/") is accepted verbatim and may resolve outside <cwd>/runs/', () => {
    const outside = join(scratch, 'elsewhere');
    writeRunDir(outside, GEN_IR);
    expect(resolveRunDir(join(scratch, 'elsewhere'), scratch)).toBe(outside);
  });

  it('path form starting with "." is treated as a path, not a bare id', () => {
    const outside = join(scratch, 'dotrun');
    writeRunDir(outside, GEN_IR);
    const relFromScratch = './dotrun';
    expect(resolveRunDir(relFromScratch, scratch)).toBe(outside);
  });

  it('refuses a run reference that resolves to a nonexistent directory', () => {
    expect(() => resolveRunDir('run_20260910_143902_ab12cd', scratch)).toThrow(/Run not found/);
  });

  it('refuses a directory with no ir.json', () => {
    const dir = join(scratch, 'runs', 'run_20260910_143902_ab12cd');
    mkdirSync(dir, { recursive: true });
    expect(() => resolveRunDir('run_20260910_143902_ab12cd', scratch)).toThrow(/No ir\.json/);
  });
});

describe('readIr (DEC-006: gen shape only)', () => {
  it('accepts a well-formed gen IR', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, GEN_IR);
    const ir = readIr(dir);
    expect(ir.entry.class).toBe('Analyst');
  });

  it('refuses a Pipeline IR citing the gens-first non-goal', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, PIPELINE_IR);
    expect(() => readIr(dir)).toThrow(/Pipeline run/);
    try {
      readIr(dir);
    } catch (e) {
      expect((e as InstanceType<typeof PromoteError>).code).toBe(2);
    }
  });

  it('refuses malformed JSON', () => {
    const dir = join(scratch, 'run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ir.json'), '{not json');
    expect(() => readIr(dir)).toThrow(/Failed to parse/);
  });

  it('refuses an ir.json missing entry.class or steps[] that is not a Pipeline either', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, { entry: {}, context: {} });
    expect(() => readIr(dir)).toThrow(/doesn't look like a gen IR/);
  });
});

// ── DEC-010 (fix round 2): the whole consumed ir.json field surface is
// UNTRUSTED input — validated fail-closed, before any use, not just the
// run-ref argument that names the directory. ──────────────────────────

describe('readIr (DEC-010: entry.class/entry.method/entry.source guards)', () => {
  it('refuses a traversal-shaped entry.class (cambium-security\'s PoC shape)', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, {
      ...GEN_IR,
      entry: { ...GEN_IR.entry, class: '../../../../tmp/PWNED' },
    });
    expect(() => readIr(dir)).toThrow(/entry\.class .* doesn't look like a safe identifier/);
    try {
      readIr(dir);
      throw new Error('expected readIr to throw');
    } catch (e) {
      expect((e as InstanceType<typeof PromoteError>).code).toBe(2);
    }
  });

  it('refuses an entry.class with shell/path metacharacters generally, not just "../"', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, { ...GEN_IR, entry: { ...GEN_IR.entry, class: 'Evil; rm -rf /' } });
    expect(() => readIr(dir)).toThrow(/entry\.class/);
  });

  it('refuses a non-identifier entry.method (also a child-process argv)', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, { ...GEN_IR, entry: { ...GEN_IR.entry, method: '../../../../tmp/evil' } });
    expect(() => readIr(dir)).toThrow(/entry\.method .* doesn't look like a safe identifier/);
  });

  it('refuses a non-string entry.method', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, { ...GEN_IR, entry: { ...GEN_IR.entry, method: 42 } });
    expect(() => readIr(dir)).toThrow(/entry\.method/);
  });

  it('refuses an entry.source that is not a string ending in .cmb.rb', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, { ...GEN_IR, entry: { ...GEN_IR.entry, source: 'app/gens/analyst.rb' } });
    expect(() => readIr(dir)).toThrow(/entry\.source .* must be a string ending in "\.cmb\.rb"/);
  });

  it('refuses a missing entry.source', () => {
    const dir = join(scratch, 'run');
    const { source, ...entryWithoutSource } = GEN_IR.entry;
    writeRunDir(dir, { ...GEN_IR, entry: entryWithoutSource });
    expect(() => readIr(dir)).toThrow(/entry\.source/);
  });

  it('accepts a well-formed entry.class/method/source (no false positives)', () => {
    const dir = join(scratch, 'run');
    writeRunDir(dir, GEN_IR);
    expect(() => readIr(dir)).not.toThrow();
  });
});

describe('resolveScaffoldContext (DEC-010 / AUD-001: entry.source containment)', () => {
  function makePackageWorkspace(root: string) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'Genfile.toml'), '[package]\nname = "probe"\nversion = "0.0.1"\n');
    mkdirSync(join(root, 'app', 'gens'), { recursive: true });
    writeFileSync(join(root, 'app', 'gens', 'analyst.cmb.rb'), 'class Analyst; end\n');
  }

  it('resolves a well-formed, in-workspace entry.source to a validated genPath', () => {
    const root = join(scratch, 'ws');
    makePackageWorkspace(root);
    const ir = { entry: { class: 'Analyst', method: 'analyze', source: 'app/gens/analyst.cmb.rb' } };
    const ctx = resolveScaffoldContext(root, ir);
    expect(ctx.genPath).toBe(join(root, 'app', 'gens', 'analyst.cmb.rb'));
  });

  it('refuses an entry.source that resolves outside the workspace (AUD-001\'s PoC shape: a traversing path to a file that exists elsewhere on disk)', () => {
    const root = join(scratch, 'ws');
    makePackageWorkspace(root);
    // A file OUTSIDE the workspace that DOES exist — proves the refusal is
    // the containment check, not the (separately-tested) "doesn't exist" case.
    const outside = join(scratch, 'elsewhere', 'evil.cmb.rb');
    mkdirSync(join(scratch, 'elsewhere'), { recursive: true });
    writeFileSync(outside, 'File.write("/tmp/PWNED", "arbitrary code ran")\n');

    const traversal = relative(root, outside);
    const ir = { entry: { class: 'Evil', method: 'analyze', source: traversal } };
    // Sanity check on the fixture itself — it must actually be shaped
    // like the vulnerable field (a traversing path ending in .cmb.rb).
    expect(ir.entry.source.startsWith('..')).toBe(true);
    expect(ir.entry.source.endsWith('.cmb.rb')).toBe(true);

    expect(() => resolveScaffoldContext(root, ir)).toThrow(
      /resolves outside the workspace.*UNTRUSTED input \(DEC-010\)/s,
    );
    try {
      resolveScaffoldContext(root, ir);
      throw new Error('expected resolveScaffoldContext to throw');
    } catch (e) {
      expect((e as InstanceType<typeof PromoteError>).code).toBe(2);
    }
  });

  it('refuses a stale/absent entry.source (in-workspace by string, but the file does not exist)', () => {
    const root = join(scratch, 'ws');
    makePackageWorkspace(root);
    const ir = { entry: { class: 'Ghost', method: 'analyze', source: 'app/gens/ghost.cmb.rb' } };
    expect(() => resolveScaffoldContext(root, ir)).toThrow(/does not exist relative to the detected workspace/);
  });
});

// ── DEC-002: context-key selection + extension sniff ───────────────────

describe('selectContextKey (DEC-002)', () => {
  it('auto-selects the single eligible (string, non "_"-prefixed) key', () => {
    const ir = { context: { document: 'text' } };
    expect(selectContextKey(ir, null)).toBe('document');
  });

  it('refuses when zero eligible keys exist', () => {
    const ir = { context: { _hidden: 'x', count: 5 } };
    expect(() => selectContextKey(ir, null)).toThrow(/No eligible context key/);
  });

  it('refuses when multiple eligible keys exist (ambiguous)', () => {
    const ir = { context: { document: 'a', page_text: 'b' } };
    expect(() => selectContextKey(ir, null)).toThrow(/Ambiguous context/);
  });

  it('--source picks an explicit key, including "_"-prefixed or non-string', () => {
    const ir = { context: { document: 'a', page_text: 'b', _hidden: 'c', count: 5 } };
    expect(selectContextKey(ir, 'page_text')).toBe('page_text');
    expect(selectContextKey(ir, '_hidden')).toBe('_hidden');
    expect(selectContextKey(ir, 'count')).toBe('count');
  });

  it('--source naming a key absent from context is refused', () => {
    const ir = { context: { document: 'a' } };
    expect(() => selectContextKey(ir, 'nope')).toThrow(/is not a key of this run's context/);
  });

  it('an empty context is treated as zero eligible keys', () => {
    expect(() => selectContextKey({ context: {} }, null)).toThrow(/No eligible context key/);
    expect(() => selectContextKey({}, null)).toThrow(/No eligible context key/);
  });
});

describe('sniffExtension (DEC-002)', () => {
  it('sniffs a JSON object', () => {
    expect(sniffExtension('{"a": 1}')).toBe('json');
  });
  it('sniffs a JSON array', () => {
    expect(sniffExtension('[1, 2, 3]')).toBe('json');
  });
  it('sniffs plain text as .txt', () => {
    expect(sniffExtension('just some prose.')).toBe('txt');
  });
  it('text that merely starts with { but is not valid JSON stays .txt', () => {
    expect(sniffExtension('{ not actually json')).toBe('txt');
  });
  it('tolerates leading/trailing whitespace before sniffing', () => {
    expect(sniffExtension('   \n{"a": 1}\n  ')).toBe('json');
  });
});

describe('resolveFixtureContent (DEC-002)', () => {
  it('a string value passes through verbatim with a sniffed extension', () => {
    expect(resolveFixtureContent('hello')).toEqual({ content: 'hello', ext: 'txt' });
    expect(resolveFixtureContent('{"a":1}')).toEqual({ content: '{"a":1}', ext: 'json' });
  });
  it('a non-string value is pretty-printed as JSON', () => {
    const { content, ext } = resolveFixtureContent({ a: 1, b: [2, 3] });
    expect(ext).toBe('json');
    expect(JSON.parse(content)).toEqual({ a: 1, b: [2, 3] });
    expect(content).toContain('\n'); // pretty-printed, not minified
  });
});

// ── DEC-008: all-or-nothing preflight ──────────────────────────────────

describe('preflight (DEC-008)', () => {
  it('does not throw when neither target exists', () => {
    const targets = computeTargets(
      { appPkgRoot: scratch },
      { entry: { class: 'Analyst' } },
      'document',
      'txt',
    );
    expect(() => preflight(targets, false)).not.toThrow();
  });

  it('throws listing every colliding path when a target exists and --force is absent', () => {
    const targets = computeTargets(
      { appPkgRoot: scratch },
      { entry: { class: 'Analyst' } },
      'document',
      'txt',
    );
    mkdirSync(join(scratch, 'examples/fixtures'), { recursive: true });
    writeFileSync(targets.fixturePath, 'existing');
    try {
      preflight(targets, false);
      throw new Error('expected preflight to throw');
    } catch (e) {
      expect((e as Error).message).toContain(targets.fixturePath);
      expect((e as Error).message).not.toContain(targets.snapshotPath); // only the actual collision is listed
    }
  });

  it('lists BOTH colliding paths when fixture and snapshot both exist', () => {
    const targets = computeTargets(
      { appPkgRoot: scratch },
      { entry: { class: 'Analyst' } },
      'document',
      'txt',
    );
    mkdirSync(join(scratch, 'examples/fixtures'), { recursive: true });
    writeFileSync(targets.fixturePath, 'existing');
    writeFileSync(targets.snapshotPath, 'existing');
    try {
      preflight(targets, false);
      throw new Error('expected preflight to throw');
    } catch (e) {
      expect((e as Error).message).toContain(targets.fixturePath);
      expect((e as Error).message).toContain(targets.snapshotPath);
    }
  });

  it('does not throw when a collision exists but --force is set', () => {
    const targets = computeTargets(
      { appPkgRoot: scratch },
      { entry: { class: 'Analyst' } },
      'document',
      'txt',
    );
    mkdirSync(join(scratch, 'examples/fixtures'), { recursive: true });
    writeFileSync(targets.fixturePath, 'existing');
    expect(() => preflight(targets, true)).not.toThrow();
  });
});

describe('computeTargets (DEC-003 naming)', () => {
  it('derives the fixed fixture/snapshot/test names from class + key + ext', () => {
    const ctx = { appPkgRoot: scratch };
    const ir = { entry: { class: 'ThemePalette' } };
    const targets = computeTargets(ctx, ir, 'swatches', 'json');
    expect(targets.snake).toBe('theme_palette');
    expect(targets.fixturePath).toBe(join(scratch, 'examples/fixtures', 'theme_palette-promoted-swatches.json'));
    expect(targets.snapshotPath).toBe(join(scratch, 'examples/fixtures', 'theme_palette-snapshot.json'));
    expect(targets.testPath).toBe(join(scratch, 'tests', 'theme_palette.test.ts'));
  });
});

// ── DEC-004: test-wiring cases 2 and 3 (fabricated file content) ──────

const FAKE_CTX = { appPkgRoot: '/fake/pkg' };

describe('wireTest (DEC-004)', () => {
  it('case 1 (absent): scaffolds a fresh test via goldenTestSource', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
    });
    expect(result.action).toBe('created');
    expect(existsSync(testPath)).toBe(true);
    const content = readFileSync(testPath, 'utf8');
    // #199 DEC-012: emitted via JSON.stringify, not a raw single-quoted
    // splice. #282: anchored on PKG_ROOT (the test file's own location),
    // not on the absolute appPkgRoot of the scaffolding machine.
    expect(content).toContain(
      `const FIXTURE = join(PKG_ROOT, ${JSON.stringify('examples/fixtures/analyst-promoted-document.txt')})`,
    );
    expect(content).not.toContain('/fake/pkg');
    expect(content).toContain("describe('Analyst'");
  });

  it('case 2 (placeholder present): replaces ONLY the FIXTURE const line', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    // #199 DEC-012: fabricated as an already-scaffolded file would really
    // look — GEN/FIXTURE emitted via JSON.stringify, not raw single-quoted.
    const scaffolded = [
      '/**',
      ' * Analyst — golden regression test (RED-140).',
      ' *   1. Create a fixture: /fake/pkg/examples/fixtures/<fixture>.txt',
      ' */',
      `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`,
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/<fixture>.txt')}`,
      "const SNAPSHOT = join(REPO_ROOT, '/fake/pkg/examples/fixtures/analyst-snapshot.json')",
    ].join('\n');
    writeFileSync(testPath, scaffolded);

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
    });
    expect(result.action).toBe('wired');

    const after = readFileSync(testPath, 'utf8');
    // #282: the rewritten line is emitted in the PKG-anchored form even
    // though the file promote found was a pre-#282 absolute-literal
    // scaffold — promote reads both shapes and writes only the new one.
    expect(after).toContain(
      `const FIXTURE = join(PKG_ROOT, ${JSON.stringify('examples/fixtures/analyst-promoted-document.txt')})`,
    );
    // Every other line is untouched, including the docstring's permanent
    // "<fixture>.txt" instructional text (which is NOT the FIXTURE const
    // and must not be mistaken for the placeholder signal).
    expect(after).toContain('1. Create a fixture: /fake/pkg/examples/fixtures/<fixture>.txt');
    expect(after).toContain(`const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`);
    expect(after).toContain("const SNAPSHOT = join(REPO_ROOT, '/fake/pkg/examples/fixtures/analyst-snapshot.json')");
  });

  it('case 3 (already wired): leaves the file byte-identical, regardless of --force intent', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const wired = [
      '/**',
      ' * Analyst — golden regression test (RED-140), hand-edited.',
      ' *   1. Create a fixture: /fake/pkg/examples/fixtures/<fixture>.txt', // permanent instructional text
      ' */',
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/analyst-promoted-document.txt')}`, // already a real path
    ].join('\n');
    writeFileSync(testPath, wired);
    const before = readFileSync(testPath, 'utf8');

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/a-DIFFERENT-fixture.txt', // simulate promoting a different key later
    });

    expect(result.action).toBe('untouched');
    expect(result.matches).toBe(false); // reported, but not acted on
    expect(readFileSync(testPath, 'utf8')).toBe(before); // byte-identical — DEC-004's core invariant
  });

  it('case 3 reports a match when the wired FIXTURE already equals what was just promoted', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    writeFileSync(
      testPath,
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/analyst-promoted-document.txt')}\n`,
    );

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
    });
    expect(result.action).toBe('untouched');
    expect(result.matches).toBe(true);
  });
});

// ── DEC-011: GEN-line mismatch reporting (cases 2/3 never edit GEN, but
// report whether it matches this run's validated entry.source) ────────

describe('wireTest (DEC-011: genRel + GEN-line mismatch reporting)', () => {
  it('case 1 (absent): a fresh test\'s GEN line is the passed genRel, not the filename convention', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: 'packages/cambium/app/gens/_moved_analyst.cmb.rb',
    });
    expect(result.action).toBe('created');
    const content = readFileSync(testPath, 'utf8');
    expect(content).toContain(`const GEN = ${JSON.stringify('packages/cambium/app/gens/_moved_analyst.cmb.rb')}`);
  });

  it('case 1 (absent), no genRel passed: falls back to the filename convention (byte-identity default)', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
    });
    expect(result.action).toBe('created');
    const content = readFileSync(testPath, 'utf8');
    // #282: the convention fallback is PKG-anchored like every other path.
    expect(content).toContain(`const GEN = join(PKG_ROOT, ${JSON.stringify('app/gens/analyst.cmb.rb')})`);
  });

  it('case 2 (placeholder present): never edits GEN, and reports a match when it agrees with genRel', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const scaffolded = [
      `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`,
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/<fixture>.txt')}`,
    ].join('\n');
    writeFileSync(testPath, scaffolded);

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: '/fake/pkg/app/gens/analyst.cmb.rb',
    });
    expect(result.action).toBe('wired');
    expect(result.genMatches).toBe(true);
    expect(readFileSync(testPath, 'utf8')).toContain(
      `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`,
    ); // untouched
  });

  it('case 2 (placeholder present): reports a mismatch (AUD-002\'s relocated-gen scenario) without editing GEN', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const scaffolded = [
      `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`, // the convention path
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/<fixture>.txt')}`,
    ].join('\n');
    writeFileSync(testPath, scaffolded);

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: 'packages/cambium/app/gens/_moved_analyst.cmb.rb', // the run's actual source
    });
    expect(result.action).toBe('wired');
    expect(result.genMatches).toBe(false);
    expect(result.genLine).toBe(`const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`);
    // GEN line itself must stay byte-identical — DEC-011 never edits it.
    expect(readFileSync(testPath, 'utf8')).toContain(
      `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}`,
    );
  });

  it('case 3 (already wired): reports a GEN mismatch without editing anything', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const wired = `const GEN = ${JSON.stringify('/fake/pkg/app/gens/analyst.cmb.rb')}\nconst FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/analyst-promoted-document.txt')}\n`;
    writeFileSync(testPath, wired);

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: 'packages/cambium/app/gens/_moved_analyst.cmb.rb',
    });
    expect(result.action).toBe('untouched');
    expect(result.genMatches).toBe(false);
    expect(readFileSync(testPath, 'utf8')).toBe(wired); // byte-identical
  });

  it('no GEN line present at all: genMatches is null (nothing to compare, no warning fires)', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    writeFileSync(
      testPath,
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/analyst-promoted-document.txt')}\n`,
    );

    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: 'packages/cambium/app/gens/_moved_analyst.cmb.rb',
    });
    expect(result.action).toBe('untouched');
    expect(result.genMatches).toBeNull();
  });
});

// ── DEC-012: goldenTestSource emits GEN/FIXTURE/SNAPSHOT via
// JSON.stringify — a quote/backtick/${ in the value can never close the
// literal early and splice a statement into the generated file
// (round-2 cambium-security finding, PIPELINE-199 § "Round-2
// cambium-security delta"). The full CLI-driven PoC lives in
// promote_e2e.test.ts; this covers the same property at the wireTest
// unit level, including the mismatch-warning round-trip. ─────────────

describe('wireTest (DEC-012: quote/backtick/${ in genRel/fixtureRel cannot break out of the generated literal)', () => {
  // Same self-closing PoC shape as the finding: "x'; console.log(...);
  // const _z='.cmb.rb" — a value that, spliced raw into `'${genRel}'`,
  // closes the string at the first "'" and re-opens a new one that the
  // template's own trailing "'" then closes, letting everything in
  // between run as live statements. Extended with a backtick and a
  // "${" sequence (both otherwise-inert inside a single-quoted string,
  // but exactly the characters DEC-012 requires JSON.stringify to
  // handle safely too).
  const PAYLOAD = "packages/cambium/app/gens/x`${1}'; console.log('INJECTED_' + 'MARKER'); const _z='.cmb.rb";

  it('case 1 (absent): a fresh test\'s GEN line safely round-trips the payload as one JSON string literal', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const result = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: PAYLOAD,
    });
    expect(result.action).toBe('created');
    const content = readFileSync(testPath, 'utf8');

    const genLineMatch = content.match(/^const GEN = (".*")$/m);
    expect(genLineMatch, `no GEN line found in:\n${content}`).not.toBeNull();
    // The whole payload — quote, backtick, ${, and all — recovers exactly
    // via JSON.parse, proving it lives inside one JSON string literal.
    expect(JSON.parse(genLineMatch![1])).toBe(PAYLOAD);

    // No breakout: the raw, unescaped injected statement text appears in
    // the file ONLY inside that one matched GEN line (safely wrapped in
    // its JSON string literal) — never a second time as live, executable
    // top-level code. (The generated file is a `.ts` module — it uses
    // real TypeScript type annotations elsewhere, e.g. `CAMBIUM:
    // string[]` — so `node --check`/plain-JS parsing isn't a meaningful
    // syntax oracle here; PIPELINE-199's e2e PoC test proves the marker
    // never executes via a real `vitest run`.)
    const rawSignature = "console.log('INJECTED_' + 'MARKER')";
    const totalOccurrences = content.split(rawSignature).length - 1;
    const occurrencesInGenLine = genLineMatch![0].split(rawSignature).length - 1;
    expect(occurrencesInGenLine).toBeGreaterThan(0);
    expect(totalOccurrences).toBe(occurrencesInGenLine);
  });

  it('case 2/3 mismatch reporting round-trips the same payload via genRel and via a wired GEN line', () => {
    const testPath = join(scratch, 'analyst.test.ts');
    const scaffolded = [
      `const GEN = ${JSON.stringify(PAYLOAD)}`,
      `const FIXTURE = ${JSON.stringify('/fake/pkg/examples/fixtures/analyst-promoted-document.txt')}`,
    ].join('\n');
    writeFileSync(testPath, scaffolded);

    // Matching genRel: no mismatch, GEN line untouched.
    const matched = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: PAYLOAD,
    });
    expect(matched.action).toBe('untouched');
    expect(matched.genMatches).toBe(true);

    // Different genRel: mismatch is reported (and would be warned on by
    // warnGenMismatch), GEN line still untouched — the payload survives
    // the round-trip through JSON.parse without corruption either way.
    const mismatched = wireTest({
      ctx: FAKE_CTX,
      pascal: 'Analyst',
      snake: 'analyst',
      method: 'analyze',
      testPath,
      fixturePathForTest: '/fake/pkg/examples/fixtures/analyst-promoted-document.txt',
      genRel: '/fake/pkg/app/gens/analyst.cmb.rb',
    });
    expect(mismatched.action).toBe('untouched');
    expect(mismatched.genMatches).toBe(false);
    expect(mismatched.genLine).toBe(`const GEN = ${JSON.stringify(PAYLOAD)}`);
    expect(readFileSync(testPath, 'utf8')).toBe(scaffolded); // byte-identical, never edited
  });
});
