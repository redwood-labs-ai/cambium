/**
 * Codebase reader tool implementation.
 * Reads source files from a local or remote repo.
 * For now, handles local filesystem paths.
 * TODO: Add git clone support for remote repos.
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname, basename } from 'node:path';

interface CodebaseReaderInput {
  path: string;
  repo_url?: string;
  ref?: string;
}

interface CodebaseReaderOutput {
  content: string;
  path: string;
  language: string;
  lines: number;
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.php': 'php',
  '.sh': 'bash',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.md': 'markdown',
};

function detectLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  return LANG_MAP[ext] ?? 'text';
}

export async function execute(input: CodebaseReaderInput): Promise<CodebaseReaderOutput> {
  // FIXME: For spike, only supports local filesystem.
  // Remote repo support (git clone) needs to be added.
  const filePath = input.path;

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').length;

  return {
    content,
    path: filePath,
    language: detectLanguage(filePath),
    lines,
  };
}
