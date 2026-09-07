/**
 * #200 (DEC-200-009): ThemePalette post-Generate tail, driven end-to-end
 * through the real runner via `cambium replay --edit` (RED-312) — the
 * sanctioned way to run Validate → Correct → Repair against a seeded
 * candidate without paying for (or depending on) a live Generate call.
 *
 * Why replay, not a plain `cambium run --mock`: this test needs EXACT,
 * hand-controlled candidates (schema-valid-but-low-contrast; schema-valid
 * with one unparseable color) to exercise specific corrector→repair paths
 * deterministically. A plain `cambium run --mock` can't be steered that
 * precisely — `mockGenerate` (the runner's deterministic mock text
 * generator, `mock-output.ts` post-#205) derives ONE fixed placeholder
 * shape per schema, not an arbitrary candidate on demand. The RED-312
 * replay `--edit` mechanism exists precisely for this ("iterate on the
 * deterministic tail without touching Generate") — drive the tail
 * directly with a hand-authored candidate instead.
 *
 * (Historical note: before #205, `mockGenerate` had no branch at all for
 * `ThemePaletteOutput` and a plain `cambium run --mock` always failed
 * Validate with all 26 fields missing — replay was the ONLY way to get a
 * schema-valid candidate into the tail. #205 made the mock schema-derived,
 * so a plain `--mock` run now validates too — see `theme_palette.test.ts`'s
 * golden — but this file still needs replay for the reason above.)
 *
 * Two scenarios:
 *
 *  1. A schema-valid, otherwise-healthy candidate (a couple of
 *     non-canonical hex notations, no contrast violations) — the tail
 *     completes clean: hex_normalize fixes the notation, contrast_floor
 *     raises nothing, no Repair fires, the run succeeds with a valid
 *     26-key palette. This is the plan's "golden" acceptance criterion
 *     (fixture → valid colors.toml-able output → pinned expectations),
 *     satisfied at the tail layer per DEC-200-009 since Generate can't
 *     honestly participate under mock for this schema.
 *
 *  2. A schema-valid but low-contrast candidate — contrast_floor raises
 *     error-severity issues on foreground/background and
 *     bright_foreground/background (and a warning on muted/background,
 *     which must never reach Repair) — proving those issues genuinely
 *     feed the repair loop (`Repair` fires). What this scenario does NOT
 *     prove, post-#205 (A-001c): the repair *heal* itself. Repair's mock
 *     reply is now a schema-derived, schema-valid palette of placeholder
 *     strings, so `ValidateAfterCorrectorRepair` passes; `CorrectAfterRepair`
 *     then re-runs only `contrast_floor`, which can't compute a contrast
 *     ratio on a non-hex placeholder and doesn't flag it, so the run ends
 *     clean without ever reaching `CorrectAcceptedWithErrors`. The actual
 *     "error → fixed" heal semantics are proven directly instead at the
 *     corrector-unit level (contrast_floor_corrector.test.ts /
 *     hex_normalize_corrector.test.ts).
 *
 *  3. (AUD-001, round 1) A schema-valid, high-contrast candidate with one
 *     genuinely unparseable color (`red: "not a colour"`) — proving
 *     `hex_normalize`'s error-severity issues ALSO feed Repair, at the
 *     same trace level as scenario 2. DEC-200-003 makes the identical
 *     "feeds repair" claim `hex_normalize` and DEC-200-004 makes for
 *     `contrast_floor`; scenario 2 alone only proved it for the latter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, 'cli/cambium.mjs');
const GEN = 'packages/cambium/app/gens/theme_palette.cmb.rb';
const FIXTURE = 'packages/cambium/examples/fixtures/omarchy_swatches.json';

// Schema-valid, high-contrast palette. `accent` and `muted` are
// deliberately non-canonical notation to prove hex_normalize still runs
// on the tail even when nothing needs repair.
const HEALTHY_CANDIDATE = {
  mode: 'dark',
  accent: '7AA2F7', // non-canonical: no '#', proves hex_normalize fixes it
  selection: '#33467c',
  muted: 'rgb(86, 95, 137)', // non-canonical: rgb() form
  background: '#1a1b26',
  dark_background: '#16161e',
  darker_background: '#101014',
  lighter_background: '#24283b',
  foreground: '#c0caf5',
  dark_foreground: '#a9b1d6',
  light_foreground: '#d5d6db',
  bright_foreground: '#ffffff',
  red: '#f7768e',
  yellow: '#e0af68',
  orange: '#ff9e64',
  green: '#9ece6a',
  cyan: '#7dcfff',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  brown: '#8b6b4a',
  bright_red: '#ff7a93',
  bright_yellow: '#e6b673',
  bright_green: '#a8d876',
  bright_cyan: '#89d7ff',
  bright_blue: '#8bb1ff',
  bright_magenta: '#c6a3ff',
};

// Schema-valid but low-contrast: foreground/background (~1.24:1) and
// bright_foreground/background (~4.33:1) both miss the 4.5:1 floor;
// muted/background (~1.09:1) misses the 2.0:1 floor (warning, must not
// feed repair). light_foreground/dark_background clears 3.0:1 easily —
// proves the check is selective, not "everything is flagged."
const LOW_CONTRAST_CANDIDATE = {
  ...HEALTHY_CANDIDATE,
  accent: '#7aa2f7',
  muted: '#7a7a7a',
  background: '#808080',
  foreground: '#909090',
  bright_foreground: '#1a1b26',
  dark_background: '#1a1b26',
  light_foreground: '#c0caf5',
};

// (AUD-001) Schema-valid, already high-contrast/canonical everywhere
// EXCEPT `red`, which is not a color at all. hex_normalize can't fix it
// (nothing to normalize to) — it's an error-severity issue, not a
// 'fixed' one — and contrast_floor sees only canonical hex from the
// other 24 color fields, so it raises nothing. Isolates hex_normalize's
// error→Repair path from contrast_floor's.
const UNPARSEABLE_COLOR_CANDIDATE = {
  ...HEALTHY_CANDIDATE,
  accent: '#7aa2f7',
  muted: '#565f89',
  red: 'not a colour',
};

function firstRunId(stderr: string): string {
  const m = stderr.match(/\[cambium\] run (run_\S+)/);
  if (!m) throw new Error(`no run id in stderr:\n${stderr}`);
  return m[1];
}

function editorScript(scratch: string, name: string, candidate: object): string {
  const path = join(scratch, name);
  const payload = JSON.stringify(candidate).replace(/'/g, `'\\''`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${payload}' > "$1"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('#200 (DEC-200-009): ThemePalette post-Generate tail via replay (mock)', () => {
  let scratch: string;
  let baseRunId: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'cambium-theme-palette-replay-'));

    // A base run to replay from. This first `cambium run --mock` fails
    // (mockGenerate can't produce a ThemePaletteOutput-shaped candidate —
    // see the file header) but still writes a run dir with ir.json +
    // output.json, which is all `cambium replay --edit` needs as a
    // starting point; --edit overwrites the candidate wholesale.
    const run = spawnSync(
      'node',
      [CLI, 'run', GEN, '--method', 'generate_palette', '--arg', FIXTURE, '--mock'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    baseRunId = firstRunId(run.stderr);
    cleanup.push(baseRunId);
  });

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    for (const id of cleanup) {
      const dir = join('runs', id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a healthy candidate clears the tail clean: hex_normalize fixes notation, contrast_floor raises nothing, no Repair', () => {
    const editor = editorScript(scratch, 'healthy-editor.sh', HEALTHY_CANDIDATE);
    const traceOut = join(scratch, 'healthy-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', baseRunId, '--edit', '--mock', '--trace', traceOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, EDITOR: editor } },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);
    if (replay.status !== 0) {
      throw new Error(`replay exited ${replay.status}\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');
    expect(types).not.toContain('Repair');
    expect(trace.final?.ok).toBe(true);

    const output = JSON.parse(readFileSync(join('runs', replayId!, 'output.json'), 'utf8'));
    // hex_normalize rewrote the non-canonical entries.
    expect(output.accent).toBe('#7aa2f7');
    expect(output.muted).toBe('#565f89');
    // Untouched fields pass through unchanged.
    expect(output.background).toBe('#1a1b26');
    expect(output.mode).toBe('dark');
    // Full 26-key §8.2 shape, every value canonical hex (mode excluded).
    const keys = Object.keys(output).sort();
    expect(keys).toHaveLength(26);
    for (const k of keys) {
      if (k === 'mode') continue;
      expect(output[k]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('a low-contrast candidate triggers contrast_floor errors that feed Repair (trace shows the loop); muted only warns', () => {
    const editor = editorScript(scratch, 'low-contrast-editor.sh', LOW_CONTRAST_CANDIDATE);
    const traceOut = join(scratch, 'low-contrast-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', baseRunId, '--edit', '--mock', '--trace', traceOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, EDITOR: editor } },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);
    // A-001c (#205): post-#205, mockGenerate CAN stage a schema-valid
    // ThemePaletteOutput heal (it derives one from the schema), so this
    // replay's exit code is no longer pinned either way — what we're
    // proving is that the loop FIRES, not what it exits with. The trace is
    // the evidence.
    if (!traceOut || !existsSync(traceOut)) {
      throw new Error(`no trace written\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');

    // The initial Correct step for contrast_floor recorded the errors...
    const contrastIssues = trace.steps
      .filter((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('contrast_floor'))
      .flatMap((s: any) => s.meta?.issues ?? []);
    const errorIssues = contrastIssues.filter((i: any) => i.severity === 'error');
    const warningIssues = contrastIssues.filter((i: any) => i.severity === 'warning');
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(errorIssues.some((i: any) => i.path === 'foreground,background')).toBe(true);
    expect(errorIssues.some((i: any) => i.path === 'bright_foreground,background')).toBe(true);
    expect(errorIssues.some((i: any) => i.path === 'light_foreground,dark_background')).toBe(false);
    expect(warningIssues.some((i: any) => i.path === 'muted,background')).toBe(true);

    // ...and those error-severity issues fed Repair (DEC-200-009's bar:
    // "the trace shows the loop").
    expect(types).toContain('Repair');

    // A-001c (#205): `CorrectAcceptedWithErrors` is NOT asserted here
    // anymore. Before #205, repair's mock reply could never match
    // ThemePaletteOutput, so ValidateAfterCorrectorRepair always failed,
    // the pre-repair candidate was kept, and the graceful-degrade step
    // fired. Now repair's mock reply is schema-derived — a fully-shaped,
    // schema-valid palette of placeholder strings (`"mock red"`, etc.) —
    // so ValidateAfterCorrectorRepair passes. `CorrectAfterRepair` then
    // re-runs only `contrast_floor` (the corrector whose error-severity
    // issues fed this repair); contrast_floor can't compute a contrast
    // ratio on a non-hex placeholder string and doesn't raise on it, so
    // it reports clean and the run finishes ok without ever reaching
    // `CorrectAcceptedWithErrors` on this path. `hex_normalize` is not
    // re-run here (see the AUD-001 case below, where it is). This does
    // NOT mean the placeholder output is desirable — see #205's change
    // record for the pre-existing, general gap this reveals (a later
    // corrector's repair can introduce values an earlier corrector would
    // have rejected, and the earlier corrector isn't re-run) — do not
    // change `contrast_floor` to "fix" this here.
  });

  it('(AUD-001) an unparseable color triggers hex_normalize errors that feed Repair (trace shows the loop)', () => {
    const editor = editorScript(scratch, 'unparseable-editor.sh', UNPARSEABLE_COLOR_CANDIDATE);
    const traceOut = join(scratch, 'unparseable-trace.json');
    const replay = spawnSync(
      'node',
      [CLI, 'replay', baseRunId, '--edit', '--mock', '--trace', traceOut],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, env: { ...process.env, EDITOR: editor } },
    );
    const replayId = (() => { try { return firstRunId(replay.stderr); } catch { return null; } })();
    if (replayId) cleanup.push(replayId);
    // Same DEC-200-009 stance as the low-contrast scenario: we're proving
    // the loop fires, not that mock can complete the heal.
    if (!existsSync(traceOut)) {
      throw new Error(`no trace written\nstdout: ${replay.stdout}\nstderr: ${replay.stderr}`);
    }

    const trace = JSON.parse(readFileSync(traceOut, 'utf8'));
    const types = trace.steps.map((s: any) => s.type);
    expect(types).toContain('ReplayResume');
    expect(types).not.toContain('Generate');

    // The initial Correct step for hex_normalize recorded the error...
    const hexIssues = trace.steps
      .filter((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('hex_normalize'))
      .flatMap((s: any) => s.meta?.issues ?? []);
    const errorIssues = hexIssues.filter((i: any) => i.severity === 'error');
    expect(errorIssues).toHaveLength(1);
    expect(errorIssues[0].path).toBe('.red');
    expect(errorIssues[0].message).toMatch(/not a colour/);

    // ...and contrast_floor stayed quiet: every other field is already
    // canonical high-contrast hex, isolating hex_normalize's path.
    const contrastIssues = trace.steps
      .filter((s: any) => s.type === 'Correct' && s.meta?.correctors?.includes('contrast_floor'))
      .flatMap((s: any) => s.meta?.issues ?? []);
    expect(contrastIssues).toEqual([]);

    // ...and the error-severity hex_normalize issue fed Repair — the
    // symmetric claim to the contrast_floor scenario above, for
    // DEC-200-003's "unparseable → error → feeds repair."
    expect(types).toContain('Repair');

    // Same graceful-degrade outcome as the low-contrast scenario, this
    // time attributed to hex_normalize.
    const accepted = trace.steps.find((s: any) => s.type === 'CorrectAcceptedWithErrors');
    expect(accepted).toBeDefined();
    expect(accepted.meta?.corrector).toBe('hex_normalize');
  });
});
