/**
 * Codebase reader tool.
 * Reads source files from local filesystem.
 * TODO: Add git clone support for remote repos.
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.php': 'php', '.sh': 'bash', '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json', '.html': 'html', '.css': 'css', '.md': 'markdown',
};

export async function execute(input: { path: string; repo_url?: string; ref?: string }): Promise<{
  content: string; path: string; language: string; lines: number;
}> {
  if (!existsSync(input.path)) throw new Error(`File not found: ${input.path}`);
  const content = readFileSync(input.path, 'utf-8');
  return {
    content,
    path: input.path,
    language: LANG_MAP[extname(input.path).toLowerCase()] ?? 'text',
    lines: content.split('\n').length,
  };
}
