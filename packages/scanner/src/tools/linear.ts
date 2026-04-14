/**
 * Linear tool implementation.
 * Calls the Linear GraphQL API.
 * Requires LINEAR_API_KEY env var.
 */

const LINEAR_API_URL = 'https://api.linear.app/graphql';

interface LinearInput {
  action: 'read' | 'update' | 'comment';
  identifier: string;
  state?: string;
  body?: string;
}

interface LinearOutput {
  success: boolean;
  issue?: {
    id: string;
    title: string;
    description: string;
    state: string;
  };
}

async function linearQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY env var not set');
  }

  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: HTTP ${res.status}`);
  }

  const json: any = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

function parseIdentifier(identifier: string): { teamKey: string; number: number } {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) throw new Error(`Invalid identifier format: ${identifier}`);
  return { teamKey: match[1], number: parseInt(match[2], 10) };
}

async function readIssue(identifier: string): Promise<LinearOutput> {
  const { teamKey, number } = parseIdentifier(identifier);

  const data = await linearQuery(
    `query($number: Int!, $teamKey: String!) {
      issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
        nodes {
          id
          title
          description
          state { name }
        }
      }
    }`,
    { number, teamKey }
  );

  const nodes = data?.issues?.nodes ?? [];
  if (!nodes.length) {
    return { success: false };
  }

  const issue = nodes[0];
  return {
    success: true,
    issue: {
      id: issue.id,
      title: issue.title,
      description: issue.description ?? '',
      state: issue.state?.name ?? 'Unknown',
    },
  };
}

async function updateIssue(identifier: string, state: string): Promise<LinearOutput> {
  // First find the issue
  const read = await readIssue(identifier);
  if (!read.success || !read.issue) {
    return { success: false };
  }

  // Find state ID
  const { teamKey, number } = parseIdentifier(identifier);
  const stateData = await linearQuery(
    `query($number: Int!, $teamKey: String!) {
      issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
        nodes {
          id
          team { states { nodes { id name type } } }
        }
      }
    }`,
    { number, teamKey }
  );

  const issue = stateData?.issues?.nodes?.[0];
  const states = issue?.team?.states?.nodes ?? [];

  const STATE_MAP: Record<string, string> = {
    'todo': 'unstarted',
    'in progress': 'started',
    'done': 'completed',
    'blocked': 'unstarted',
  };

  let targetState = states.find(
    (s: any) => s.name.toLowerCase() === state.toLowerCase()
  );

  if (!targetState) {
    const targetType = STATE_MAP[state.toLowerCase()];
    if (targetType) {
      targetState = states.find((s: any) => s.type === targetType);
    }
  }

  if (!targetState) {
    return { success: false };
  }

  await linearQuery(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issue.id, stateId: targetState.id }
  );

  return { success: true, issue: { ...read.issue!, state: targetState.name } };
}

async function addComment(identifier: string, body: string): Promise<LinearOutput> {
  const read = await readIssue(identifier);
  if (!read.success || !read.issue) {
    return { success: false };
  }

  // Need to get the raw issue ID for mutation
  const { teamKey, number } = parseIdentifier(identifier);
  const data = await linearQuery(
    `query($number: Int!, $teamKey: String!) {
      issues(filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }) {
        nodes { id }
      }
    }`,
    { number, teamKey }
  );

  const issueId = data?.issues?.nodes?.[0]?.id;
  if (!issueId) return { success: false };

  await linearQuery(
    `mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body }
  );

  return { success: true };
}

export async function execute(input: LinearInput): Promise<LinearOutput> {
  switch (input.action) {
    case 'read':
      return readIssue(input.identifier);
    case 'update':
      if (!input.state) throw new Error('state required for update action');
      return updateIssue(input.identifier, input.state);
    case 'comment':
      if (!input.body) throw new Error('body required for comment action');
      return addComment(input.identifier, input.body);
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}
