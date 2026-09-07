/**
 * #200 (DEC-200-003): canonicalize color fields to lowercase `#rrggbb`.
 *
 * Accepts `#RGB`, `#RRGGBB`, `RRGGBB` (no `#`), and `rgb(r, g, b)` in any
 * case, and rewrites each to canonical lowercase `#rrggbb` — a
 * `severity: 'fixed'` issue per rewrite. A value that already IS
 * canonical is left untouched with no issue. Anything unparseable is
 * `severity: 'error'` (feeds the repair loop — see `contrast_floor`,
 * which requires canonical hex to compute contrast ratios).
 *
 * The `mode` field (`"dark" | "light"`) is not a color and is skipped by
 * name; every other string field is treated as a color field.
 */
import type { CorrectorFn, CorrectorResult, CorrectorIssue } from '../../../cambium-runner/src/correctors/types.js';

const SKIP_FIELDS = new Set(['mode']);

const HEX3 = /^#([0-9a-fA-F]{3})$/;
const HEX6_WITH_HASH = /^#([0-9a-fA-F]{6})$/;
const HEX6_NO_HASH = /^([0-9a-fA-F]{6})$/;
const RGB_FN = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const CANONICAL = /^#[0-9a-f]{6}$/;

function toHex2(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  return n.toString(16).padStart(2, '0');
}

/** Normalize a color string to canonical `#rrggbb`, or null if unparseable. */
function normalizeColor(value: string): string | null {
  const trimmed = value.trim();

  let m = trimmed.match(HEX3);
  if (m) {
    const [r, g, b] = m[1].toLowerCase().split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  m = trimmed.match(HEX6_WITH_HASH);
  if (m) return `#${m[1].toLowerCase()}`;

  m = trimmed.match(HEX6_NO_HASH);
  if (m) return `#${m[1].toLowerCase()}`;

  m = trimmed.match(RGB_FN);
  if (m) {
    const r = toHex2(Number(m[1]));
    const g = toHex2(Number(m[2]));
    const b = toHex2(Number(m[3]));
    if (r === null || g === null || b === null) return null;
    return `#${r}${g}${b}`;
  }

  return null;
}

export const hex_normalize: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);

  walkAndCorrect(output, '', issues);

  return {
    corrected: issues.some(i => i.severity === 'fixed'),
    output,
    issues,
  };
};

function walkAndCorrect(obj: any, basePath: string, issues: CorrectorIssue[]): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkAndCorrect(obj[i], `${basePath}[${i}]`, issues);
    }
    return;
  }

  for (const k of Object.keys(obj)) {
    if (SKIP_FIELDS.has(k)) continue;
    const val = obj[k];
    if (typeof val === 'string') {
      if (CANONICAL.test(val)) continue;
      const normalized = normalizeColor(val);
      if (normalized) {
        issues.push({ path: `${basePath}.${k}`, message: `Normalized color to canonical #rrggbb`, severity: 'fixed', original: val, corrected: normalized });
        obj[k] = normalized;
      } else {
        issues.push({ path: `${basePath}.${k}`, message: `Unparseable color "${val}", expected #rrggbb, #rgb, rrggbb, or rgb(r, g, b)`, severity: 'error', original: val });
      }
    } else if (typeof val === 'object') {
      walkAndCorrect(val, `${basePath}.${k}`, issues);
    }
  }
}
