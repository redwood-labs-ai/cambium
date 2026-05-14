#!/usr/bin/env node
/**
 * check-ruby-deps — supply-chain defense for Cambium's Ruby surface.
 *
 * Cambium's Ruby code (`ruby/cambium/**.rb`) intentionally uses ONLY Ruby
 * stdlib. There is no Gemfile, no Bundler, no gemspec, and no third-party
 * gem dependency. This script enforces that posture: it scans every Ruby
 * file under `ruby/` for `require '<name>'` and fails if any name is not
 * in the explicit stdlib allowlist below.
 *
 * Why stdlib-only?
 *
 *   Cambium's compiler `instance_eval`s user gens and policy packs — every
 *   gem that's loaded at compile time becomes part of the trusted compute
 *   base for that compile. The recent run of attacks against the RubyGems
 *   ecosystem (typosquats, account-takeover-driven malicious releases,
 *   transitive-dep compromises) raised the cost of every gem in that base.
 *   Zero gems is the only base where the count is genuinely zero — pinning
 *   doesn't help, because the attack surface is "ever runs at all," not
 *   "runs at a particular version."
 *
 *   This is asymmetric to the npm side: the TypeScript runner has real
 *   dependencies because the alternatives are worse (parsers, schema libs,
 *   PDF extraction). Ruby's stdlib is wide enough that `require 'json'`
 *   and `require 'digest'` cover the compiler's needs.
 *
 * What about user gens?
 *
 *   User-authored `.cmb.rb` files CAN `require` arbitrary gems — they're
 *   first-class Ruby. This script does NOT scan user files; the user is
 *   responsible for their own gem hygiene. SECURITY.md documents the
 *   recommended tooling (`bundle config frozen true`, `bundler-audit`,
 *   exact-version pinning).
 *
 * Adding to the allowlist:
 *
 *   The allowlist below is "Ruby stdlib that ships with every supported
 *   Ruby version." Adding a new entry should be considered carefully — is
 *   the module actually stdlib (shipped with the interpreter), or is it a
 *   bundled gem that defaults to a recent version on RubyGems? Bundled
 *   gems (e.g., `csv` on Ruby 3.4+) are RubyGems-resolved at runtime and
 *   carry the supply-chain risk this script is designed to prevent.
 *
 *   If Cambium ever genuinely needs a non-stdlib gem, the project goes
 *   through the same gate as adding an npm dep: explicit user approval,
 *   exact pinning, minimum-age policy, documented in CLAUDE.md and
 *   SECURITY.md. Don't quietly add to this allowlist to work around the
 *   gate.
 *
 * Exit codes:
 *   0  — every require resolves to stdlib
 *   1  — at least one non-stdlib require found
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUBY_ROOT = resolve(ROOT, 'ruby');

// Allowlist: Ruby stdlib modules that ship with every supported interpreter.
// Limited to what Cambium's own code actually uses. Expanding this is a
// security-relevant change — see the header comment.
const STDLIB_ALLOWLIST = new Set([
  // Currently used by Cambium's compiler/runtime:
  'json',
  'digest',

  // Add new entries here only after auditing — each entry is part of
  // Cambium's compile-time TCB. If you find yourself wanting to add a
  // non-stdlib name, STOP and route it through the dependency-policy gate
  // (CLAUDE.md "Dependency policy" cluster).
]);

function listRubyFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...listRubyFiles(p));
    } else if (s.isFile() && p.endsWith('.rb')) {
      out.push(p);
    }
  }
  return out;
}

// Match `require '<name>'` and `require "<name>"`. Deliberately does NOT
// match `require_relative` (those are internal) or `Gem::...` references.
// The regex is permissive enough to catch the canonical forms; if a
// contributor uses `require ?json` or some other clever evasion, that's a
// signal to investigate manually, not a reason to make the regex Turing-
// complete.
const REQUIRE_RE = /^\s*require\s+['"]([^'"]+)['"]/gm;

let files;
try {
  files = listRubyFiles(RUBY_ROOT);
} catch (err) {
  console.error(`Could not scan ${RUBY_ROOT}: ${err.message}`);
  process.exit(2);
}

console.log(`Scanning ${files.length} Ruby file(s) under ruby/ for non-stdlib requires`);

const violations = [];
const requires = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let m;
  // reset lastIndex because the regex is /g
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(src)) !== null) {
    const name = m[1];
    // Compute the line number from the match offset for actionable output.
    const lineNo = src.slice(0, m.index).split('\n').length;
    const rel = relative(ROOT, file);
    requires.push({ file: rel, line: lineNo, name });
    // A require like 'json/add/core' is still rooted at the 'json' stdlib.
    // Match by stripping the path tail and checking the root segment.
    const root = name.split('/')[0];
    if (!STDLIB_ALLOWLIST.has(root)) {
      violations.push({ file: rel, line: lineNo, name });
    }
  }
}

console.log(`Found ${requires.length} require statement(s):`);
for (const r of requires) {
  const flag = STDLIB_ALLOWLIST.has(r.name.split('/')[0]) ? '  ✓' : '  ✗';
  console.log(`${flag} ${r.file}:${r.line}  require '${r.name}'`);
}

if (violations.length > 0) {
  console.error(`\n✗ ${violations.length} non-stdlib require(s) found:`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  require '${v.name}'`);
  }
  console.error(
    `\nCambium's Ruby surface is stdlib-only by policy — see SECURITY.md ` +
    `"Ruby supply chain" and CLAUDE.md "Dependency policy" cluster. Every ` +
    `gem becomes part of the compile-time trusted compute base; the bar for ` +
    `adding one is the same as for an npm dep (explicit user approval, exact ` +
    `pinning, minimum-age policy).`,
  );
  process.exit(1);
}

console.log(`\n✓ All ${requires.length} requires resolve to Ruby stdlib (allowlist).`);
