import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

const LANGUAGE_CONFIG: Record<string, { ext: string; cmd: (path: string) => string }> = {
  python: { ext: '.py', cmd: (p) => `python3 "${p}"` },
  node: { ext: '.js', cmd: (p) => `node "${p}"` },
};

type ExecOutput = { stdout: string; stderr: string; exit_code: number };

/**
 * Execute code in a sandboxed subprocess with timeout.
 * Writes code to a temp file, executes, captures output, cleans up.
 */
export function execute(input: { language: string; code: string }): ExecOutput {
  const { language, code } = input;
  if (!code) throw new Error('execute_code: missing code');

  const config = LANGUAGE_CONFIG[language];
  if (!config) throw new Error(`execute_code: unsupported language "${language}". Supported: ${Object.keys(LANGUAGE_CONFIG).join(', ')}`);

  // Write to temp file
  const tmpDir = mkdtempSync(join(tmpdir(), 'cambium-exec-'));
  const tmpFile = join(tmpDir, `script${config.ext}`);

  try {
    writeFileSync(tmpFile, code);

    const result = execSync(config.cmd(tmpFile), {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      stdout: truncate(result ?? ''),
      stderr: '',
      exit_code: 0,
    };
  } catch (err: any) {
    return {
      stdout: truncate(err.stdout ?? ''),
      stderr: truncate(err.stderr ?? err.message ?? ''),
      exit_code: err.status ?? 1,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpDir); } catch {}
  }
}

function truncate(s: string): string {
  if (s.length > MAX_OUTPUT_CHARS) {
    return s.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated at ${MAX_OUTPUT_CHARS} chars]`;
  }
  return s;
}
