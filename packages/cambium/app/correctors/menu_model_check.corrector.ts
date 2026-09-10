/**
 * #201 (docs/omarchy/SPEC.md §5.8): merges the proposed menu entry into
 * the current overlay and runs Omarchy's OWN vendored parser
 * (`./vendor/omarchy/menu_model.cjs`, pinned commit — see that file's
 * header for the loading decision) against the merged result, rather
 * than re-implementing its inference rules. Two failure classes,
 * error-severity (feeds the repair loop):
 *
 *   1. **Parse failure.** The current overlay itself fails to survive
 *      `stripJsonc` + `JSON.parse` — most commonly an inline trailing
 *      `//` comment, which the vendored stripper does NOT catch (it
 *      only strips whole-line comments; see `menu_model_check_corrector
 *      .test.ts`). SPEC §5.8: "a file that fails to parse contributes
 *      no entries" — every entry vanishes, not just the new one — so
 *      there is nothing safe to merge a proposal into.
 *
 *   2. **Wrong inferred kind.** The proposal sets BOTH `action` and
 *      `target`. `normalizeItem`'s kind inference is a priority order
 *      (`action` wins over `target`, which wins over the bare-submenu
 *      default) — an entry with both silently loses whichever one the
 *      request actually meant.
 *
 * `context.document` is the gen's input document, JSON-shaped
 * `{ request, overlay }` (see `menu_entry.cmb.rb`). This gen declares no
 * `grounded_in`, so it reaches the corrector via the runner's
 * `getGroundingDocument` legacy `ctx.document` fallback — no citation
 * machinery is involved, this corrector never touches `fields`.
 *
 * Security note (#201 audit): `./vendor/omarchy/menu_model.cjs` sits
 * inside `app/correctors/` but is NOT itself discoverable as a
 * corrector. `loadAppCorrectors` (`packages/cambium-runner/src/
 * correctors/app-loader.ts`) and `cambium lint`'s corrector check both
 * scan `app/correctors/` with a non-recursive, suffix-filtered
 * `readdirSync` (`entry.endsWith('.corrector.ts')`) — `vendor/` (a
 * directory) and `menu_model.cjs` (wrong suffix) are both silently
 * outside that scan, never reaching the name-regex or realpath-escape
 * checks. This is safe BECAUSE the scan has no recursive-descent code
 * path today — if that ever changes, re-derive this analysis before
 * assuming vendored trees under `app/correctors/` stay inert.
 */
import { createRequire } from 'node:module';
import type { CorrectorFn, CorrectorResult, CorrectorIssue } from '../../../cambium-runner/src/correctors/types.js';

const require = createRequire(import.meta.url);
const { stripJsonc, parseMenuJsonc } = require('./vendor/omarchy/menu_model.cjs') as {
  stripJsonc: (raw: string) => string;
  parseMenuJsonc: (raw: string) => Array<Record<string, any>>;
};

type RequestDocument = { request?: string; overlay?: string };

// The subset of Omarchy's item fields a proposal can set (RED-419 schema
// in menu_entry.cmb.rb). `id` is handled separately — it becomes the
// merged object's key, not one of its values.
const ENTRY_FIELDS = ['label', 'action', 'target', 'when', 'checked', 'disabled'] as const;

function parseRequestDocument(raw: string | undefined): RequestDocument {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const menu_model_check: CorrectorFn = (data, context): CorrectorResult => {
  const issues: CorrectorIssue[] = [];
  const { overlay } = parseRequestDocument(context.document);

  // 1. The CURRENT overlay must parse clean on its own — otherwise
  // there's nothing safe to merge into (SPEC §5.8).
  let overlayObj: Record<string, unknown> = {};
  if (overlay) {
    const stripped = stripJsonc(overlay);
    if (stripped.trim()) {
      try {
        const parsed = JSON.parse(stripped);
        overlayObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (e: any) {
        issues.push({
          path: 'overlay',
          message: `Current overlay failed to parse (${e?.message ?? 'invalid JSON'}) after stripping comments — Omarchy's parser drops every entry when the file fails to parse, so nothing can be safely merged into it.`,
          severity: 'error',
          original: overlay,
        });
        return { corrected: false, output: data, issues };
      }
    }
  }

  const id = typeof data?.id === 'string' ? data.id.trim() : '';
  if (!id) {
    issues.push({ path: 'id', message: 'Proposed entry has no id — cannot merge into the overlay.', severity: 'error' });
    return { corrected: false, output: data, issues };
  }

  // 2. Merge the proposal's set fields into the overlay, in the same
  // flat-object-keyed-by-id shape `parseMenuJsonc` expects.
  const entryRaw: Record<string, string> = {};
  for (const field of ENTRY_FIELDS) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === 'string' && value !== '') entryRaw[field] = value;
  }
  const merged = { ...overlayObj, [id]: entryRaw };

  // 3. Run the REAL parser against the merged result.
  const mergedText = JSON.stringify(merged);
  const items = parseMenuJsonc(mergedText);
  if (items.length !== Object.keys(merged).length) {
    issues.push({
      path: 'overlay',
      message: `Merging the proposed entry produced an overlay that failed to parse — got ${items.length} item(s) back for ${Object.keys(merged).length} declared key(s). Omarchy's parser drops every entry when this happens, not just the new one.`,
      severity: 'error',
      original: mergedText,
    });
    return { corrected: false, output: data, issues };
  }

  const entry = items.find(item => item.id === id);
  if (!entry) {
    issues.push({ path: 'id', message: `Proposed entry "${id}" did not survive the real parser.`, severity: 'error' });
    return { corrected: false, output: data, issues };
  }

  // 4. Wrong inferred kind: both `action` and `target` set.
  if (entryRaw.action && entryRaw.target) {
    issues.push({
      path: 'action,target',
      message: `Entry "${id}" sets both action ("${entryRaw.action}") and target ("${entryRaw.target}") — Omarchy's real parser infers kind="${entry.kind}" for this entry, silently discarding the other field's behavior. Set exactly one of action/target.`,
      severity: 'error',
      original: { action: entryRaw.action, target: entryRaw.target },
    });
  }

  // Report-only, like `contrast_floor` (#200): picking which of
  // action/target to keep is a semantic call for the repair loop's
  // model turn, not something this corrector should guess at.
  return { corrected: false, output: data, issues };
};
