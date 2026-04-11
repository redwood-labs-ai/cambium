import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const MAX_CHARS = 100_000;
const MAX_LINES = 2000;

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.o', '.a', '.pyc', '.class', '.wasm',
]);

const BLOCKED_PATHS = [
  /\.env$/,
  /credentials/i,
  /\.ssh\//,
  /\.aws\//,
  /\.docker\//,
  /\/etc\/shadow$/,
  /\/etc\/sudoers/,
  /\.gnupg\//,
];

type ReadOutput = { content: string; total_lines: number; truncated: boolean };

/**
 * Read file tool. Guarded with size limits, binary detection, and sensitive path blocking.
 * Inspired by Hermes Agent's read_file implementation.
 */
export function execute(input: { path: string; offset?: number; limit?: number }): ReadOutput {
  const { path, offset = 1, limit = 500 } = input;
  if (!path) throw new Error('read_file: missing path');

  // Block sensitive paths
  for (const pattern of BLOCKED_PATHS) {
    if (pattern.test(path)) {
      throw new Error(`read_file: access denied — "${path}" matches sensitive path pattern`);
    }
  }

  // Block binary files
  const ext = extname(path).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`read_file: "${path}" appears to be a binary file (${ext})`);
  }

  // Check file size
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`read_file: file not found — "${path}"`);
  }

  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`read_file: file too large (${Math.round(stat.size / 1024 / 1024)}MB). Max 10MB.`);
  }

  // Read file
  const raw = readFileSync(path, 'utf8');
  const allLines = raw.split('\n');
  const totalLines = allLines.length;

  // Apply offset and limit
  const clampedLimit = Math.min(limit, MAX_LINES);
  const startLine = Math.max(0, offset - 1);
  const selectedLines = allLines.slice(startLine, startLine + clampedLimit);
  let content = selectedLines.join('\n');

  // Enforce character limit
  let truncated = selectedLines.length < (totalLines - startLine);
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS) + `\n\n[truncated at ${MAX_CHARS} chars]`;
    truncated = true;
  }

  return { content, total_lines: totalLines, truncated };
}
