/**
 * STEP-004 (DEC-001/008) — the parity test that IS the enforcement
 * mechanism DEC-001 points at. `cli/schema-export.mjs` is canonical;
 * `ruby/cambium/schema_export.rb` is a deliberate, pattern-for-pattern
 * mirror. This test runs BOTH implementations over the same checked-in
 * corpus (`fixtures/schema-export-corpus.json`) and fails if either:
 *   (a) disagrees with the corpus's recorded `verdict`/`exports`, or
 *   (b) disagrees with the OTHER implementation.
 *
 * Ruby is spawned exactly ONCE for the whole corpus (CI is 4-core;
 * per-fixture spawns would be the wrong trade here) via
 * `fixtures/schema-export-harness.rb`, which reads the corpus JSON on
 * stdin and prints `{ verdict, exports }` results (same order) on
 * stdout.
 *
 * `exports` is compared as a SET (sorted before comparison) — order is
 * an implementation artifact of scan sequence, not a contract either
 * language promises; every real call site sorts before display anyway
 * (`cli/generate.mjs`, `cli/lint.mjs`, `compile.rb`'s did-you-mean all
 * do `.sort()`/`.sort`). `verdict` is compared exactly (it's a single
 * enum value, no ordering question).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, listExports } from '../../../cli/schema-export.mjs';

const REPO_ROOT = process.cwd();
const CORPUS_PATH = join(REPO_ROOT, 'packages/cambium/tests/fixtures/schema-export-corpus.json');
const HARNESS_PATH = join(REPO_ROOT, 'packages/cambium/tests/fixtures/schema-export-harness.rb');

type CorpusEntry = {
  desc: string;
  content: string;
  name: string;
  verdict: 'exported' | 'absent' | 'unknowable';
  exports?: string[];
};

const corpus: CorpusEntry[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

describe('schema-export parity (DEC-001/008): JS canonical vs Ruby mirror', () => {
  it('the corpus has real coverage (sanity floor, not itself the spec)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(26);
    const verdicts = new Set(corpus.map((c) => c.verdict));
    expect(verdicts).toEqual(new Set(['exported', 'absent', 'unknowable']));
  });

  it('JS module matches every corpus entry', () => {
    const failures: string[] = [];
    for (const entry of corpus) {
      const verdict = classify(entry.content, entry.name);
      if (verdict !== entry.verdict) {
        failures.push(`"${entry.desc}": verdict got ${verdict}, want ${entry.verdict}`);
      }
      if (entry.exports) {
        const exp = sorted(listExports(entry.content));
        const want = sorted(entry.exports);
        if (JSON.stringify(exp) !== JSON.stringify(want)) {
          failures.push(`"${entry.desc}": exports got ${JSON.stringify(exp)}, want ${JSON.stringify(want)}`);
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  describe('Ruby mirror', () => {
    let rubyResults: { verdict: string; exports: string[] }[];

    beforeAll(() => {
      // ONE Ruby process for the whole corpus (4-core CI budget, DEC-008).
      const r = spawnSync('ruby', [HARNESS_PATH], {
        input: JSON.stringify(corpus),
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });
      if (r.status !== 0) {
        throw new Error(`Ruby harness failed (status ${r.status}): ${r.stderr}`);
      }
      rubyResults = JSON.parse(r.stdout);
    });

    it('matches every corpus entry', () => {
      const failures: string[] = [];
      corpus.forEach((entry, i) => {
        const result = rubyResults[i];
        if (result.verdict !== entry.verdict) {
          failures.push(`"${entry.desc}": verdict got ${result.verdict}, want ${entry.verdict}`);
        }
        if (entry.exports) {
          const exp = sorted(result.exports);
          const want = sorted(entry.exports);
          if (JSON.stringify(exp) !== JSON.stringify(want)) {
            failures.push(`"${entry.desc}": exports got ${JSON.stringify(exp)}, want ${JSON.stringify(want)}`);
          }
        }
      });
      expect(failures, failures.join('\n')).toEqual([]);
    });

    it('agrees with the JS module on every entry (the actual parity guarantee)', () => {
      const failures: string[] = [];
      corpus.forEach((entry, i) => {
        const jsVerdict = classify(entry.content, entry.name);
        const rbResult = rubyResults[i];
        if (jsVerdict !== rbResult.verdict) {
          failures.push(`"${entry.desc}": JS says ${jsVerdict}, Ruby says ${rbResult.verdict}`);
        }
        const jsExports = sorted(listExports(entry.content));
        const rbExports = sorted(rbResult.exports);
        if (JSON.stringify(jsExports) !== JSON.stringify(rbExports)) {
          failures.push(`"${entry.desc}": JS exports ${JSON.stringify(jsExports)}, Ruby exports ${JSON.stringify(rbExports)}`);
        }
      });
      expect(failures, failures.join('\n')).toEqual([]);
    });
  });
});
