import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Matches "April 8, 2026", "8 April 2026", "Apr 8 2026", etc.
const INFORMAL_DATE = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})\b/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;

/**
 * Dates corrector: walks string fields, validates ISO-8601,
 * and reformats informal dates where possible.
 */
export const dates: CorrectorFn = (data, _context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const output = structuredClone(data);

  walkAndCorrect(output, '', issues);

  return {
    corrected: issues.some(i => i.severity === 'fixed'),
    output,
    issues,
  };
};

function tryReformat(value: string): string | null {
  const m = value.match(INFORMAL_DATE);
  if (!m) return null;

  let day: string, month: string, year: string;

  if (m[4]) {
    // "Month Day, Year" format
    month = MONTH_MAP[m[4].toLowerCase()];
    day = m[5].padStart(2, '0');
    year = m[6];
  } else {
    // "Day Month Year" format
    day = m[1].padStart(2, '0');
    month = MONTH_MAP[m[2].toLowerCase()];
    year = m[3];
  }

  const iso = `${year}-${month}-${day}`;
  // Validate the date is real
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return null;
  return iso;
}

function walkAndCorrect(obj: any, basePath: string, issues: CorrectorIssue[]): void {
  if (obj == null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        const fixed = tryReformat(obj[i]);
        if (fixed && obj[i] !== fixed) {
          issues.push({ path: `${basePath}[${i}]`, message: `Reformatted date to ISO-8601`, severity: 'fixed', original: obj[i], corrected: fixed });
          obj[i] = fixed;
        }
      } else {
        walkAndCorrect(obj[i], `${basePath}[${i}]`, issues);
      }
    }
    return;
  }

  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (typeof val === 'string') {
      // Check if it looks like a date field but isn't ISO-8601
      if (looksLikeDateField(k) && !ISO_DATE.test(val)) {
        const fixed = tryReformat(val);
        if (fixed) {
          issues.push({ path: `${basePath}.${k}`, message: `Reformatted date to ISO-8601`, severity: 'fixed', original: val, corrected: fixed });
          obj[k] = fixed;
        } else {
          issues.push({ path: `${basePath}.${k}`, message: `Non-ISO date string could not be auto-reformatted`, severity: 'warning', original: val });
        }
      }
    } else {
      walkAndCorrect(val, `${basePath}.${k}`, issues);
    }
  }
}

function looksLikeDateField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('date') || lower.includes('_at') || lower === 'timestamp' || lower.endsWith('_on');
}
