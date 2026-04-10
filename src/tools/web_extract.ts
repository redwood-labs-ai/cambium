const MAX_CONTENT_CHARS = 50_000;

// Private/internal IP patterns (SSRF protection)
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\.0\.0\.0$/,
  /^169\.254\./,
  /^\[::1\]$/,
];

type ExtractOutput = { title: string; content: string };

/**
 * Web extract tool. Fetches a URL and returns cleaned text content.
 * Includes SSRF protection against internal/private URLs.
 */
export async function execute(input: { url: string }): Promise<ExtractOutput> {
  const { url } = input;
  if (!url) throw new Error('web_extract: missing url');

  // SSRF protection
  try {
    const parsed = new URL(url);
    for (const pattern of BLOCKED_HOSTS) {
      if (pattern.test(parsed.hostname)) {
        throw new Error(`web_extract: blocked internal URL "${parsed.hostname}"`);
      }
    }
  } catch (e: any) {
    if (e.message.includes('blocked')) throw e;
    throw new Error(`web_extract: invalid URL "${url}"`);
  }

  const res = await fetch(url, {
    headers: {
      'user-agent': 'Cambium/0.1 (web_extract tool)',
      'accept': 'text/html, text/plain, application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`web_extract: HTTP ${res.status} for ${url}`);

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();

  // Extract title
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Strip HTML to text
  let content: string;
  if (contentType.includes('text/html')) {
    content = stripHtml(raw);
  } else {
    content = raw;
  }

  // Truncate
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS) + `\n\n[truncated at ${MAX_CONTENT_CHARS} chars]`;
  }

  return { title, content };
}

function stripHtml(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Convert common block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode basic HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
