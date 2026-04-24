#!/usr/bin/env node
/**
 * postpack — restore the working package.json after `npm pack` /
 * `npm publish`. Paired with prepack.mjs which wrote the backup.
 *
 * Runs after the tarball is generated, regardless of whether the pack
 * succeeded. If prepack didn't run (no backup found), this is a no-op.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = resolve(ROOT, 'package.json');
const BAK = resolve(ROOT, 'package.json.bak');

if (!existsSync(BAK)) {
  console.error('postpack: no package.json.bak found — nothing to restore.');
  process.exit(0);
}

writeFileSync(PKG, readFileSync(BAK, 'utf8'));
unlinkSync(BAK);
console.error('postpack: restored working package.json from backup.');
