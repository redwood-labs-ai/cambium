import process from 'node:process';

type SearchResult = { title: string; url: string; snippet: string };
type SearchOutput = { results: SearchResult[] };

/**
 * Web search tool. Supports Tavily and Exa backends.
 * Backend selected by available API key: TAVILY_API_KEY or EXA_API_KEY.
 */
export async function execute(input: { query: string; limit?: number }): Promise<SearchOutput> {
  const { query, limit = 5 } = input;
  if (!query) throw new Error('web_search: missing query');

  const tavilyKey = process.env.TAVILY_API_KEY;
  const exaKey = process.env.EXA_API_KEY;

  if (tavilyKey) return searchTavily(query, limit, tavilyKey);
  if (exaKey) return searchExa(query, limit, exaKey);

  throw new Error('web_search: no search backend configured. Set TAVILY_API_KEY or EXA_API_KEY.');
}

async function searchTavily(query: string, limit: number, apiKey: string): Promise<SearchOutput> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      include_answer: false,
    }),
  });

  if (!res.ok) throw new Error(`Tavily error: HTTP ${res.status}`);
  const json: any = await res.json();

  const results: SearchResult[] = (json.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));

  return { results };
}

async function searchExa(query: string, limit: number, apiKey: string): Promise<SearchOutput> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      num_results: limit,
      type: 'neural',
      use_autoprompt: true,
    }),
  });

  if (!res.ok) throw new Error(`Exa error: HTTP ${res.status}`);
  const json: any = await res.json();

  const results: SearchResult[] = (json.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.text ?? r.highlights?.[0] ?? '',
  }));

  return { results };
}
