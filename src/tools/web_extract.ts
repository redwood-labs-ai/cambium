import type { ToolContext } from './tool-context.js';

const MAX_CONTENT_CHARS = 50_000;

type ExtractOutput = { title: string; content: string };

/**
 * Web extract tool. Fetches a URL and returns cleaned text content.
 *
 * SSRF / egress policy is enforced by `ctx.fetch` when a ToolContext is
 * provided (the runner builds one from the gen's `security network:`
 * block). In-tool fallback for direct unit-test calls uses global fetch,
 * which has NO policy enforcement — tests should pass a ctx or live with it.
 */
export async function execute(
  input: { url: string },
  ctx?: ToolContext,
): Promise<ExtractOutput> {
  const { url } = input;
  if (!url) throw new Error('web_extract: missing url');

  const fetchFn = ctx?.fetch ?? globalThis.fetch;
  const res = await fetchFn(url, {
    headers: {
      'user-agent': 'Cambium/0.1 (web_extract tool)',
      'accept': 'text/html, text/plain, application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`web_extract: HTTP ${res.status} for ${url}`);

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  let content = contentType.includes('text/html') ? stripHtml(raw) : raw;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS) + `\n\n[truncated at ${MAX_CONTENT_CHARS} chars]`;
  }

  return { title, content };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
