import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type { ToolContext } from '../tools/tool-context.js';

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
 * Read file tool. Guarded with size limits, binary detection, sensitive path
 * blocking, and — when dispatched through the runner — filesystem roots
 * enforcement via ctx.filesystemPolicy.
 *
 * Roots enforcement uses realpathSync so symlinks can't escape the declared
 * root. A gen with `security filesystem: { roots: [...] }` that calls
 * read_file with a path outside those roots gets a hard deny, same as a
 * network tool hitting an un-allowlisted host.
 */
export function execute(
  input: { path: string; offset?: number; limit?: number },
  ctx?: ToolContext,
): ReadOutput {
  const { path, offset = 1, limit = 500 } = input;
  if (!path) throw new Error('read_file: missing path');

  // Resolve to absolute before any check so relative paths and `..` segments
  // are normalised consistently.
  const absPath = resolve(path);

  // Block sensitive paths (denylist — belt-and-suspenders even within roots).
  for (const pattern of BLOCKED_PATHS) {
    if (pattern.test(absPath)) {
      throw new Error(`read_file: access denied — "${path}" matches sensitive path pattern`);
    }
  }

  // Block binary files
  const ext = extname(absPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`read_file: "${path}" appears to be a binary file (${ext})`);
  }

  // Check file size (stat before realpath so we surface not-found before
  // the roots check, keeping error messages unambiguous).
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    throw new Error(`read_file: file not found — "${path}"`);
  }

  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`read_file: file too large (${Math.round(stat.size / 1024 / 1024)}MB). Max 10MB.`);
  }

  // Filesystem roots enforcement. When the gen declared `security filesystem:
  // { roots: [...] }`, verify that the realpath of the target falls within at
  // least one declared root. realpathSync resolves symlinks so a link pointing
  // outside the root can't be used to escape it.
  if (ctx?.filesystemPolicy) {
    const { roots } = ctx.filesystemPolicy;
    if (roots.length > 0) {
      let real: string;
      try {
        real = realpathSync(absPath);
      } catch {
        throw new Error(`read_file: file not found — "${path}"`);
      }
      const permitted = roots.some((root) => {
        const absRoot = isAbsolute(root) ? root : resolve(root);
        // Resolve the root too so symlinked tmp dirs on macOS (/var →
        // /private/var) compare against the same canonical form as `real`.
        let realRoot: string;
        try { realRoot = realpathSync(absRoot); } catch { return false; }
        // Normalise the root with a trailing separator so /foo doesn't
        // accidentally match /foobar.
        const rootWithSep = realRoot.endsWith('/') ? realRoot : realRoot + '/';
        return real === realRoot || real.startsWith(rootWithSep);
      });
      if (!permitted) {
        throw new Error(
          `read_file: access denied — "${path}" is outside the declared filesystem roots ` +
          `(${roots.join(', ')})`,
        );
      }
    }
  }

  // Read file
  const raw = readFileSync(absPath, 'utf8');
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
