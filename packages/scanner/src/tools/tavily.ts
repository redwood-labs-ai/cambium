/**
 * Tavily search tool implementation.
 * Calls the Tavily API for AI-optimized web search.
 * Requires TAVILY_API_KEY env var.
 */

const TAVILY_API_URL = 'https://api.tavily.com/search';

interface TavilyInput {
  query: string;
  max_results?: number;
  search_depth?: 'basic' | 'advanced';
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyOutput {
  results: TavilyResult[];
  answer?: string;
}

export async function execute(input: TavilyInput): Promise<TavilyOutput> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY env var not set');
  }

  const body = {
    query: input.query,
    max_results: input.max_results ?? 5,
    search_depth: input.search_depth ?? 'basic',
    include_answer: input.search_depth === 'advanced',
  };

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily API error: HTTP ${res.status} ${text}`);
  }

  const json: any = await res.json();

  const results: TavilyResult[] = (json.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.content ?? '',
    score: r.score ?? 0,
  }));

  const output: TavilyOutput = { results };

  if (json.answer) {
    output.answer = json.answer;
  }

  return output;
}
