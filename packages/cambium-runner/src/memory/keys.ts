import { randomUUID } from 'node:crypto';

/**
 * RED-215 phase 3: runtime key & session resolution.
 *
 * `:session`-scoped memory addresses a bucket by a session id —
 * auto-generated per run unless the caller sets CAMBIUM_SESSION_ID to
 * reuse one across runs. The generated id is echoed to stderr the
 * first time a run creates it, so the caller can copy it back.
 *
 * `--memory-key name=value` CLI flags supply values for any `keyed_by`
 * slot a memory or pool declares. The parser here accepts the raw
 * string arguments and returns a flat Record.
 */

const KEY_VALUE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.+)$/;
const SAFE_VALUE_RE = /^[a-zA-Z0-9_\-]+$/;
const MAX_VALUE_LEN = 128;

// RED-305: schedule IDs are composite `<snake_gen>.<method>.<slug>`
// with `.` as the explicit separator. The Ruby compiler generates
// them from components that each match `[a-z][a-z0-9_]*`, but we
// independently validate here because path.join does not reject
// `..` segments — it silently normalizes them. This is the same
// belt-and-suspenders stance `validateSafeSegment` takes for
// --memory-key and CAMBIUM_SESSION_ID.
const SCHEDULE_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const MAX_SCHEDULE_ID_LEN = 256;

export function validateScheduleId(id: string, source: string): void {
  if (id.length > MAX_SCHEDULE_ID_LEN) {
    throw new Error(
      `${source} schedule id exceeds ${MAX_SCHEDULE_ID_LEN} characters (got ${id.length}).`,
    );
  }
  if (!SCHEDULE_ID_RE.test(id)) {
    throw new Error(
      `${source} schedule id must match /^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$/ ` +
        `(got '${id}'). Schedule ids are composite gen.method.slug identifiers; ` +
        `each component must be a lowercase snake_case word.`,
    );
  }
}

/** Shared validator for any user-supplied string that ends up as a directory
 *  segment. Enforces both the character set (blocking path traversal,
 *  whitespace, NULs) and a max length so pathological inputs can't blow up
 *  OS path limits with a confusing error.
 */
function validateSafeSegment(name: string, value: string, source: string): void {
  if (value.length > MAX_VALUE_LEN) {
    throw new Error(
      `${source} ${name}=<value> exceeds ${MAX_VALUE_LEN} characters (got ${value.length}). ` +
        'Values are used as directory names — keep them short.',
    );
  }
  if (!SAFE_VALUE_RE.test(value)) {
    throw new Error(
      `${source} ${name}=<value> must match /^[a-zA-Z0-9_\\-]+$/ (got '${value}'). ` +
        'Values are used as directory names — anything that could escape the memory root is rejected.',
    );
  }
}

/**
 * Parse an array of raw "name=value" strings into a Record. Rejects
 * malformed entries with a message that names the offender so the
 * user knows which flag to fix.
 */
export function parseMemoryKeys(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of raw) {
    const m = r.match(KEY_VALUE_RE);
    if (!m) {
      throw new Error(
        `--memory-key must be <name>=<value> with a snake_case name (got '${r}').`,
      );
    }
    const [, name, value] = m;
    validateSafeSegment(name, value, '--memory-key');
    out[name] = value;
  }
  return out;
}

/**
 * Resolve the session id for this run. CAMBIUM_SESSION_ID wins; otherwise
 * a fresh UUID is generated and (when echoed = true) printed to stderr so
 * the caller can reuse it for follow-up runs.
 *
 * Because the resolved id flows directly into `node:path#join` as a
 * directory segment for `runs/memory/session/<id>/…`, the env-supplied
 * value is run through the same SAFE_VALUE_RE check as --memory-key
 * values. `join` normalises `..` segments rather than rejecting them, so
 * without this guard `CAMBIUM_SESSION_ID=../../etc` would escape the
 * memory root. Auto-generated UUIDs are hyphen-legal and safe.
 */
export function resolveSessionId(env: NodeJS.ProcessEnv = process.env, echo = true): string {
  const fromEnv = env.CAMBIUM_SESSION_ID?.trim();
  if (fromEnv) {
    validateSafeSegment('CAMBIUM_SESSION_ID', fromEnv, 'env');
    return fromEnv;
  }
  const id = randomUUID();
  if (echo) {
    process.stderr.write(
      `[cambium] session id: ${id} (set CAMBIUM_SESSION_ID=${id} to reuse)\n`,
    );
  }
  return id;
}
