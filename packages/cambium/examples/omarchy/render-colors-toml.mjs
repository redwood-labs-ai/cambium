#!/usr/bin/env node
// #200 (DEC-200-006): ThemePalette proposal object → `colors.toml` text.
//
// Pure function + thin CLI, string templating — no TOML library (26
// flat string keys don't need one, and no new dep is available anyway).
// Key order and grouping are fixed to spec §8.2: mode / accent,selection,
// muted / 4 backgrounds / 4 foregrounds / 8 colors / 6 brights, one
// blank line between groups, every value double-quoted.
//
// Propose-only: this writes nothing to disk. CLI mode reads a
// ThemePalette output JSON object on stdin and writes `colors.toml`
// text to stdout.
//
// Usage: node render-colors-toml.mjs < palette.json > colors.toml

import { fileURLToPath } from 'node:url';

// spec §8.2 grouping, in order.
const GROUPS = [
  ['mode'],
  ['accent', 'selection', 'muted'],
  ['background', 'dark_background', 'darker_background', 'lighter_background'],
  ['foreground', 'dark_foreground', 'light_foreground', 'bright_foreground'],
  ['red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'],
  ['bright_red', 'bright_yellow', 'bright_green', 'bright_cyan', 'bright_blue', 'bright_magenta'],
];

export const COLORS_TOML_KEYS = GROUPS.flat();

/**
 * Render a ThemePalette proposal object to `colors.toml` text.
 *
 * @param {Record<string, string>} obj must have exactly the 26 §8.2 keys.
 * @returns {string} TOML text, key = "value" per line, one blank line
 *   between groups, no trailing content beyond a final newline.
 */
export function renderColorsToml(obj) {
  const missing = COLORS_TOML_KEYS.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new Error(`render-colors-toml: missing key(s): ${missing.join(', ')}`);
  }
  const extra = Object.keys(obj).filter((k) => !COLORS_TOML_KEYS.includes(k));
  if (extra.length > 0) {
    throw new Error(`render-colors-toml: unexpected key(s) not in the §8.2 schema: ${extra.join(', ')}`);
  }

  const blocks = GROUPS.map((keys) =>
    keys.map((k) => `${k} = "${obj[k]}"`).join('\n'),
  );
  return blocks.join('\n\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdin();
  let obj;
  try {
    obj = JSON.parse(input);
  } catch (err) {
    console.error(`render-colors-toml: invalid JSON on stdin: ${err.message}`);
    process.exit(1);
  }
  try {
    process.stdout.write(renderColorsToml(obj));
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
