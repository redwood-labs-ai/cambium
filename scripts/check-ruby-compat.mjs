#!/usr/bin/env node
/**
 * check-ruby-compat — guard against Ruby-2.x patterns removed in Ruby 3.x.
 *
 * RED-379, complement to RED-378 (docker-test-on-Ruby-3.x). RED-377 shipped
 * as an urgent 0.4.1 patch because `Proc.new` (implicit-block capture) was
 * removed in Ruby 3.0 but still worked on the EOL Ruby 2.6 the bug slipped
 * past in dev. Cambium's Ruby surface (`ruby/cambium/**.rb`) is re-evaluated
 * against every user gen at compile time, so a 2.x-only construct bites
 * downstream users immediately on a 3.x interpreter (Alpine ships 3.4).
 *
 * This is the cheap, audit-time half of the defense: a regex sweep that
 * catches the pattern BEFORE compute is spent running the suite. RED-378's
 * docker run catches it after; both ship (defense in depth).
 *
 * Why a regex script, not Rubocop:
 *   - Rubocop is a gem, which violates the stdlib-only stance
 *     (`check-ruby-deps.mjs`). Adding it would defeat the very policy this
 *     family of checks protects.
 *   - The surface is tiny (`ruby/**`, ~4 files); regex is plenty.
 *   - Node is already present for `npm run`, so zero extra install,
 *     cross-platform.
 *
 * The pattern list is a CLOSED ENUM. Extending it is a deliberate edit, not
 * regex sprawl — each new pattern is a documented decision. Start with the
 * RED-377 pattern + three high-likelihood next-bites; add as discovered.
 *
 * Exit codes:
 *   0  — no removed-in-3.x patterns found
 *   1  — at least one match (do not ship)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUBY_ROOT = resolve(ROOT, 'ruby');

// CLOSED ENUM — each entry is a deliberate decision. `re` MUST be global (/g)
// so we can sweep all matches per file with line numbers.
const PATTERNS = [
  {
    id: 'proc-new-implicit-block',
    // `Proc.new` NOT immediately followed by `{` (a literal block) or `(`
    // (an explicit `&blk` arg). The bare form captures the enclosing
    // method's block implicitly — removed in Ruby 3.0 (the RED-377 bug).
    re: /\bProc\.new\b(?!\s*[{(])/g,
    desc: 'Proc.new with implicit block capture',
    fix: 'pass an explicit `&block` parameter and use it directly. Ruby 3.0 removed Proc.new\'s implicit-block capture. `Proc.new { ... }` and `Proc.new(&blk)` are fine.',
  },
  {
    id: 'kernel-open-url',
    // `Kernel.open(...)` or a bare `open("http(s)://...")` not preceded by a
    // `.`/word char (i.e. not `File.open`, `io.open`). open-uri's Kernel#open
    // URL handling was removed in Ruby 3.0.
    re: /\bKernel\.open\s*\(|(?<![.\w])open\s*\(\s*["']https?:\/\//g,
    desc: 'Kernel#open URL fetching',
    fix: "use `URI.open(...)` (require 'open-uri') or Net::HTTP. Ruby 3.0 removed open-uri's Kernel#open URL handling.",
  },
  {
    id: 'object-match-nonstring',
    // `=~ Integer|Array|Hash|Object.new` — Object#=~ against a non-string-y
    // receiver. Deprecated in 2.6, removed in 3.2 (now raises NoMethodError).
    // Narrow on purpose so it doesn't flag legitimate `str =~ /regex/`.
    re: /=~\s*(?:Integer|Array|Hash|Object\.new)\b/g,
    desc: 'Object#=~ against a non-string receiver',
    fix: 'Object#=~ was removed in Ruby 3.2. Use an explicit `Regexp#match?` / `String#match?`.',
  },
  {
    id: 'taint-mechanism',
    // `.taint` / `.untaint` / `.tainted?` — the taint mechanism, removed in
    // Ruby 3.2 (the methods are gone; calling them raises NoMethodError).
    re: /\.(?:taint|untaint|tainted\?)\b/g,
    desc: 'taint mechanism (.taint / .untaint / .tainted?)',
    fix: 'the taint mechanism was removed in Ruby 3.2. Remove the call.',
  },
];

function listRubyFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listRubyFiles(p));
    else if (s.isFile() && p.endsWith('.rb')) out.push(p);
  }
  return out;
}

let files;
try {
  files = listRubyFiles(RUBY_ROOT);
} catch (err) {
  console.error(`Could not scan ${RUBY_ROOT}: ${err.message}`);
  process.exit(2);
}

console.log(`Scanning ${files.length} Ruby file(s) under ruby/ for removed-in-3.x patterns`);

const violations = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(src)) !== null) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      violations.push({ file: rel, line: lineNo, match: m[0].trim(), pat });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} Ruby 3.x compat issue(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.pat.desc}]  ${JSON.stringify(v.match)}`);
    console.error(`      → ${v.pat.fix}\n`);
  }
  console.error(
    'These constructs were removed in Ruby 3.x but may still work on an EOL 2.x\n' +
    'dev interpreter. Cambium re-evaluates its Ruby surface against every user gen\n' +
    'at compile time, so they break downstream users on 3.x (Alpine ships 3.4).\n' +
    'See RED-377 / RED-379. Pattern list is closed-enum in scripts/check-ruby-compat.mjs.',
  );
  process.exit(1);
}

console.log(`\n✓ No removed-in-3.x patterns found across ${files.length} Ruby file(s).`);
