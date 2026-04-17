import type { MemoryEntry, MemoryDecl } from './types.js';

/**
 * RED-215 phase 3: format memory hits as a block to inject into the
 * system prompt. Shape matches the illustration in the design note.
 *
 *   ## Memory
 *   ### conversation (last 20 entries)
 *   [2026-04-16T14:02:01Z] input: <truncated> / output: <truncated>
 *   ...
 *
 * Entries are JSON-encoded `{ input, output }` today; if the JSON
 * parse fails we render the raw content string — the prompt still
 * gets useful context and the model can handle the noise.
 */
export function formatMemoryBlock(
  sections: Array<{ decl: MemoryDecl; entries: MemoryEntry[] }>,
): string | null {
  const present = sections.filter(s => s.entries.length > 0);
  if (present.length === 0) return null;

  const lines: string[] = ['## Memory'];
  for (const { decl, entries } of present) {
    const heading = decl.strategy === 'sliding_window'
      ? `### ${decl.name} (last ${entries.length} entries)`
      : `### ${decl.name}`;
    lines.push(heading);
    for (const e of entries) {
      lines.push(formatEntryLine(e));
    }
  }
  return lines.join('\n');
}

function formatEntryLine(e: MemoryEntry): string {
  let body: string;
  try {
    const parsed = JSON.parse(e.content);
    if (parsed && typeof parsed === 'object' && 'input' in parsed && 'output' in parsed) {
      body = `input: ${truncate(String(parsed.input))} / output: ${truncate(String(parsed.output))}`;
    } else {
      body = truncate(e.content);
    }
  } catch {
    body = truncate(e.content);
  }
  return `[${e.ts}] ${body}`;
}

/**
 * Collapse newlines and truncate. Newline-stripping is not cosmetic — a
 * prior run's stored entry could contain literal markdown headers
 * (`\n## Memory\n### fake_section\n...`); without this, those would be
 * rendered verbatim into the next system prompt and could subvert the
 * memory block's structure. Collapsing to a single line keeps the block
 * structurally well-formed regardless of stored content.
 */
function truncate(s: string, max = 200): string {
  const flat = s.replace(/[\r\n]+/g, ' ↵ ');
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}
