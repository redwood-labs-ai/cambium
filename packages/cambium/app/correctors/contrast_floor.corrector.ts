/**
 * #200 (DEC-200-004): WCAG 2.1 contrast-ratio floor on declared fg/bg
 * pairs. Requires canonical `#rrggbb` hex — run AFTER `hex_normalize`
 * (DEC-200-005: declaration order in the gen is pipeline order).
 *
 * Contrast ratio = (L1 + 0.05) / (L2 + 0.05), L1 the lighter of the two
 * relative luminances.
 *
 *   foreground        × background      >= 4.5  →  error
 *   bright_foreground  × background      >= 4.5  →  error
 *   light_foreground   × dark_background >= 3.0  →  error
 *   muted              × background      >= 2.0  →  warning (low-contrast
 *                                                    by design; never
 *                                                    feeds repair)
 *
 * A full pairwise matrix and AAA (7:1) thresholds were rejected: a real
 * design system intentionally contains low-contrast pairs, and AAA
 * rejects half the real-world dark themes. These four pairs are the
 * "unreadable desktop" failure modes from spec §5.2.
 */
import type { CorrectorFn, CorrectorResult, CorrectorIssue } from '../../../cambium-runner/src/correctors/types.js';

type Pair = { fg: string; bg: string; floor: number; severity: 'error' | 'warning' };

const PAIRS: Pair[] = [
  { fg: 'foreground', bg: 'background', floor: 4.5, severity: 'error' },
  { fg: 'bright_foreground', bg: 'background', floor: 4.5, severity: 'error' },
  { fg: 'light_foreground', bg: 'dark_background', floor: 3.0, severity: 'error' },
  { fg: 'muted', bg: 'background', floor: 2.0, severity: 'warning' },
];

const CANONICAL_HEX = /^#([0-9a-f]{6})$/;

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(CANONICAL_HEX);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// WCAG 2.1 relative luminance.
function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const linearize = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hexA: string, hexB: string): number | null {
  const rgbA = hexToRgb(hexA);
  const rgbB = hexToRgb(hexB);
  if (!rgbA || !rgbB) return null;
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

export const contrast_floor: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  // contrast_floor never rewrites values — it only reports; hex_normalize
  // owns fixing color notation. Correcting contrast means picking a new
  // color, which is a semantic call for the repair loop's model turn.
  const output = data;

  for (const { fg, bg, floor, severity } of PAIRS) {
    const fgVal = data?.[fg];
    const bgVal = data?.[bg];
    if (typeof fgVal !== 'string' || typeof bgVal !== 'string') continue;

    const ratio = contrastRatio(fgVal, bgVal);
    // Not canonical hex (e.g. hex_normalize already flagged it as an
    // unparseable error) — nothing to compute a ratio from here.
    if (ratio === null) continue;

    if (ratio < floor) {
      issues.push({
        path: `${fg},${bg}`,
        message: `Contrast between ${fg} (${fgVal}) and ${bg} (${bgVal}) is ${ratio.toFixed(2)}:1, below the ${floor}:1 floor`,
        severity,
        original: { [fg]: fgVal, [bg]: bgVal },
      });
    }
  }

  return {
    corrected: false,
    output,
    issues,
  };
};
