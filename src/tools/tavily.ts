/**
 * Tavily search tool.
 * Calls the Tavily API for AI-optimized web search.
 * Requires TAVILY_API_KEY env var.
 */

const TAVILY_API_URL = 'https://api.tavily.com/search';

export async function execute(input: {
  query: string;
  max_results?: number;
  search_depth?: 'basic' | 'advanced';
}): Promise<{ results: Array<{ title: string; url: string; content: string; score: number }>; answer?: string }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY env var not set');

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: input.query,
      max_results: input.max_results ?? 5,
      search_depth: input.search_depth ?? 'basic',
      include_answer: input.search_depth === 'advanced',
    }),
  });

  if (!res.ok) throw new Error(`Tavily API error: HTTP ${res.status}`);
  const json: any = await res.json();

  return {
    results: (json.results ?? []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score ?? 0,
    })),
    ...(json.answer ? { answer: json.answer } : {}),
  };
}
