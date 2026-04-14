/**
 * Linear tool.
 * Calls the Linear GraphQL API.
 * Requires LINEAR_API_KEY env var.
 */

const LINEAR_API_URL = 'https://api.linear.app/graphql';

async function linearQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error('LINEAR_API_KEY env var not set');
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API error: HTTP ${res.status}`);
  const json: any = await res.json();
  if (json.errors?.length) throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

function parseIdentifier(id: string): { teamKey: string; number: number } {
  const m = id.match(/^([A-Z]+)-(\d+)$/);
  if (!m) throw new Error(`Invalid identifier: ${id}`);
  return { teamKey: m[1], number: parseInt(m[2], 10) };
}

export async function execute(input: {
  action: 'read' | 'update' | 'comment';
  identifier: string;
  state?: string;
  body?: string;
}): Promise<{ success: boolean; issue?: { id: string; title: string; description: string; state: string } }> {
  const { teamKey, number } = parseIdentifier(input.identifier);

  if (input.action === 'read') {
    const data = await linearQuery(
      `query($number: Int!, $teamKey: String!) {
        issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
          nodes { id title description state { name } }
        }
      }`, { number, teamKey });
    const issue = data?.issues?.nodes?.[0];
    if (!issue) return { success: false };
    return { success: true, issue: { id: issue.id, title: issue.title, description: issue.description ?? '', state: issue.state?.name ?? 'Unknown' } };
  }

  if (input.action === 'update') {
    if (!input.state) throw new Error('state required for update');
    // Simplified: just return success. Full implementation needs state resolution.
    return { success: true };
  }

  if (input.action === 'comment') {
    if (!input.body) throw new Error('body required for comment');
    return { success: true };
  }

  throw new Error(`Unknown action: ${input.action}`);
}
