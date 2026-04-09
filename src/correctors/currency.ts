import type { CorrectorFn, CorrectorResult, CorrectorIssue } from './types.js';

const CURRENCY_ALIASES: Record<string, string> = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', '$': 'USD',
  euro: 'EUR', euros: 'EUR', eur: 'EUR', '€': 'EUR',
  pound: 'GBP', pounds: 'GBP', gbp: 'GBP', '£': 'GBP',
  yen: 'JPY', jpy: 'JPY', '¥': 'JPY',
  franc: 'CHF', francs: 'CHF', chf: 'CHF',
  yuan: 'CNY', renminbi: 'CNY', rmb: 'CNY', cny: 'CNY',
  rupee: 'INR', rupees: 'INR', inr: 'INR',
  won: 'KRW', krw: 'KRW',
  real: 'BRL', reais: 'BRL', brl: 'BRL',
  peso: 'MXN', pesos: 'MXN', mxn: 'MXN',
  cad: 'CAD', aud: 'AUD', nzd: 'NZD', sgd: 'SGD', hkd: 'HKD',
};

// Already a valid ISO 4217 code (3 uppercase letters)
const ISO_4217 = /^[A-Z]{3}$/;

/**
 * Currency corrector: normalizes currency names/symbols to ISO 4217 codes.
 */
export const currency: CorrectorFn = (data, _context): CorrectorResult => {
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
    const val = obj[k];
    if (typeof val === 'string' && looksLikeCurrencyField(k)) {
      if (!ISO_4217.test(val)) {
        const normalized = CURRENCY_ALIASES[val.toLowerCase()];
        if (normalized) {
          issues.push({ path: `${basePath}.${k}`, message: `Normalized currency to ISO 4217`, severity: 'fixed', original: val, corrected: normalized });
          obj[k] = normalized;
        } else {
          issues.push({ path: `${basePath}.${k}`, message: `Unknown currency "${val}", could not normalize`, severity: 'warning', original: val });
        }
      }
    } else if (typeof val === 'object') {
      walkAndCorrect(val, `${basePath}.${k}`, issues);
    }
  }
}

function looksLikeCurrencyField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('currency') || lower.endsWith('_cur') || lower === 'cur';
}
