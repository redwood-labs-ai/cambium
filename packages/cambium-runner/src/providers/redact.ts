// Provider error-body redaction helper.
//
// Strips known-sensitive content (API keys, bearer tokens) from upstream
// HTTP error bodies before they are surfaced in error messages and traces.
// The function is pure (no I/O) — call it on the already-read body string.
// Truncation is applied AFTER redaction so a secret that falls near the cap
// is never partially preserved.

const PATTERNS: [RegExp, string][] = [
  // 1. Bearer tokens in Authorization-style values (case-insensitive)
  [/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]'],
  // 2. Labelled API-key / secret / token field values
  [/((?:x-api-key|api[_-]key|api[_-]secret|access[_-]token|secret[_-]key)\s*[:=]\s*)\S+/gi, '$1[REDACTED]'],
  // 3. sk-* / ak-* / rk-* / tok-* prefixed secret tokens (≥8 chars after prefix)
  [/\b(sk|ak|rk|tok)-[A-Za-z0-9\-_]{8,}/g, '[REDACTED]'],
];

const MAX_BODY_CHARS = 1500;

/**
 * Redact known-sensitive patterns from an upstream HTTP error body, then
 * truncate to `MAX_BODY_CHARS`. Returns an empty string for empty input.
 */
export function redactErrorBody(raw: string): string {
  if (!raw) return '';
  let s = raw;
  for (const [pattern, replacement] of PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  return s.slice(0, MAX_BODY_CHARS);
}
