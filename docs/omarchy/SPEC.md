# Cambium × Omarchy 4 (Quattro) — Integration Opportunity Spec

**Status:** Draft v2 — source-verified, reframed around agent ergonomics (§2.5)
**Date:** 2026-09-01 (v2 same day)
**Author:** Working notes — lives at `docs/omarchy/SPEC.md`; commit on a docs
branch so the `[OM]` Forgejo tickets can link its § references
**Question this answers:** Is there a real opportunity to integrate Cambium into Omarchy at an OS level, and if so, at which layer?
**v2 delta:** §1 claims verified against `origin/quattro` source (one correction,
§1.1). New §2.5 states the design axis: the primary operator is the *driving
agent*, and the system is one pattern (sense → propose → apply), not a feature
list. New Tier-1 candidates §5.8–§5.10 (menu-entry gen, MCP adapter +
self-describing catalog, the `cambium` skill). §5.6 verified smaller than
feared (§7.8). New cross-cutting requirements §6.6–§6.8. Evidence rows added
to §8.1.

---

## 0. Provenance — what this is based on

Everything in §1 is read from Omarchy source, not from release blogs. The blogs
were used only to locate the release and are cited in §9.

| Source | Detail |
|---|---|
| Local install | Omarchy **3.8.5** (`~/.local/share/omarchy`, `git describe` → `v3.8.4-5-gf4378f0d`) |
| Quattro source read at | `origin/quattro` @ **`7d58bb9a`** ("Merge PR #7972 from acrogenesis/harden-browser-policy-dirs"), i.e. slightly past `v4.0.2` |
| Tags present locally | `v4.0.0-beta3`, `v4.0.0`, `v4.0.1`, `v4.0.2` |
| Remote | `https://github.com/basecamp/omarchy.git` |
| Release date | 4.0.0 "Quattro" — 2026-08-14 |
| Also inspected | `origin/hermes-agent` (unmerged; adds an 11th agent CLI) |

**Caveat:** this box is on 3.8.5. Nothing below has been *run* against Quattro —
it is a source read. Quattro comes up in a VM when the plugin work starts; the
first two deliverables need no Omarchy present at all (§7.1).

**Verification (v2):** every claim in §1 was re-checked against `origin/quattro`
@ `7d58bb9a` on 2026-09-01. All confirmed except one overstatement, corrected
in §1.1 (`pi` and `ori` launch with no bypass flag). The verification pass also
surfaced integration surface the v1 read missed — folded in as §5.8–§5.10 and
the v2 blocks in §5.5, with evidence in §8.1.

---

## 1. What Omarchy 4 actually shipped for AI

Three distinct things. Keeping them distinct is the whole analysis.

### 1.1 An agent *launcher* (`bin/omarchy-agent`)

A bash case statement over ten third-party agent CLIs — eleven with Hermes on
the unmerged branch — most invoked in their own don't-stop-to-ask mode (the
source notes "Pi and Ori have none to skip"; those two get no bypass flag):

```bash
claude)  command=(claude --permission-mode auto) ;;
crush)   command=(crush --yolo) ;;
agy)     command=(agy --dangerously-skip-permissions) ;;
copilot) command=(copilot --allow-all) ;;
codex)   command=(codex --approve-for-me) ;;
grok)    command=(grok --permission-mode bypassPermissions) ;;
omp)     command=(omp --auto-approve) ;;
opencode) command=(opencode --auto) ;;
```

Roster: `pi`, `omp`, `opencode`, `ori`, `claude`, `codex`, `crush`, `grok`,
`agy`, `copilot` (+ `hermes`). Installed lazily via **mise** stubs in
`~/.local/bin/`. Default stored in `~/.config/omarchy/defaults/agent`.
Launched by `Super + Shift + Ctrl + A`, or `a` inline; window gets a fixed
app-id `org.omarchy.agent` so window rules can single it out.

Notable comment in the source — the constraint that shaped it:

> `# Agents refuse to remember trust for $HOME, so launches from the keybinding
> # or menu start in the work directory instead of re-asking on every session.`

**This layer is a process launcher. It contains no model call of Omarchy's own.**

### 1.2 Usage telemetry (`bin/omarchy-agent-usage-*`)

- One collector per provider: `omarchy-agent-usage-claude` (Python, ~800 lines,
  reads `~/.claude/projects` transcripts + the OAuth usage endpoint),
  `-codex`, `-fireworks`.
- `omarchy-agent-usage-update` runs them in parallel, validates each is JSON
  (`jq -e .`), atomically `mv`s into
  `${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/<agent>.json`.
- The QML panel (`shell/plugins/agents/`) only ever reads those files.

The extension contract is stated in the source, verbatim:

> `# Each omarchy-agent-usage-<agent> collector prints one display-ready JSON`
> `# record; this writes them to ~/.local/state/omarchy/agents/usage/ where the`
> `# agents panel watches them. Adding an agent is adding a collector — the`
> `# panel picks up any record that appears here.`

**This is an open, documented extension point.** See §5.3.

### 1.3 Prompts-as-markdown (skills)

`bin/omarchy-agent-crash` builds a heredoc of facts from `coredumpctl`, points
at `default/agents/skills/diagnose-crash/SKILL.md`, and hands the whole thing to
whatever agent is default. The `omarchy` skill (`default/agents/skills/omarchy/`
— SKILL.md plus capture/contributing/hooks/hyprland/plugins/theming) is
symlinked into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`,
`~/.gemini/config/skills`, and `~/.agents/skills`.

The manual is candid about the reliability of this approach:

> "you should treat this skill as experimental. Different models will use it to
> different effect. It's best to run in plan mode first... be ready to rollback
> changes or even invoking `omarchy reinstall configs`, if the agent makes a
> mess of everything."

**That sentence is the market for generation engineering, written by the
distro's own manual.**

### 1.4 The plugin system (the substrate that makes integration possible)

The desktop is now **one long-lived Quickshell process** (`omarchy-shell`),
replacing Waybar / Walker / Mako / SwayOSD / hyprlock / hypridle / swaybg /
polkit-gnome. Almost everything on screen is a plugin inside it.

- Manifest: `manifest.json`, `schemaVersion: 1` (exact JSON number), required
  `id`, `name`, `version`, `kinds`, `entryPoints`.
- Kinds: `bar` | `bar-widget` | `panel` | `overlay` | `menu` | **`service`**
  (headless singleton, no UI).
- Third-party plugins live in `~/.config/omarchy/plugins/<id>/`; first-party in
  `$OMARCHY_PATH/shell/plugins/`. Same discovery path.
- Enabled state in `~/.config/omarchy/shell.json`. IPC: `omarchy-shell shell
  rescanPlugins` / `enablePlugin <id> '{}'` / `listPlugins`.
- Distribution is **just a public git repo**: `omarchy plugin add <git-url>
  --enable`. Community directory at omarchyplugins.com.
- Hot reload: saving any file under `~/.config/omarchy/plugins/` reloads it.

**Trust model — important.** `omarchy-plugin-validate` checks schema version,
required fields, reserved `omarchy.*` namespace, entry points that are safe
relative paths (no `/`, no `..`, no newline) and exist, an entry point per
declared kind, and **no symlinks anywhere in the folder**. That is a
*path-safety* validator, not a sandbox. The manual says so plainly:

> "A plugin isn't a config file — it's code that runs for as long as your
> session does, with everything your user account can reach."

Cambium people will recognise that guard family — it is the same class of check
as our RED-222/RED-214 symbol-into-path guards. It is well done. It is also
orthogonal to what a plugin does once loaded.

**How plugins do I/O.** Across all first-party QML: **84 × `Process {}`**,
**14 × `FileView {}`**, **43 × `import Quickshell.Io`**, and **zero
`XMLHttpRequest`**. The idiom is: a CLI produces JSON, QML spawns it or watches
its output file. Stated in `shell/plugins/agents/Main.qml`:

> `// All extraction lives behind omarchy-agent-usage-update, which writes one`
> `// JSON record per agent into the usage directory; this file only discovers`
> `// those records, watches them for changes...`

**Any Cambium integration must follow this shape: a CLI/shim that prints JSON,
never QML that talks HTTP directly.** (§6.2)

### 1.5 Packaging and hooks

- Moved from a `~/.local/share/omarchy` git checkout to **pacman packages**;
  system files under `/usr/share/omarchy` and `/etc`. An ALPM guard routes
  updates through `omarchy update` so snapshots and migrations run.
- `omarchy-keyring` package exists; repo currently `SigLevel = Optional TrustAll`
  (SHA-256, no PGP yet) — signing infrastructure is staged but not enforced.
- Event hooks (`bin/omarchy-hook`) run `~/.config/omarchy/hooks/<name>` and
  every file in `<name>.d/`. **Verified call sites:** `battery-low`, `font-set`,
  `post-boot`, `post-update`, `pre-refresh-pacman`, `theme-set`.

### 1.6 What is *not* there — the gap

Having read the AI surface end to end:

> **There is no point in Omarchy where a language model produces a typed,
> validated, bounded, traced result.**

Every AI feature is one of:
- an autonomous third-party agent with every permission gate disabled, or
- a bash/Python script emitting JSON that nothing validates beyond `jq -e .`, or
- a markdown file of instructions with no enforcement mechanism.

A plugin author who wants an LLM answer today has exactly one option: shell out
to `claude --permission-mode auto` and parse prose out of the transcript.

---

## 2. The strategic read

Omarchy 4 **validates the thesis** — a mainstream Linux distribution now assumes
an agent is present, budgets for it in the top bar, and hands it core dumps.

But it integrated at the **launcher layer**. The layer beneath — *the OS wants a
structured answer from a model* — is unowned and, on current evidence, will stay
unowned: Omarchy's response to "we need more AI capability" is to **add an
eleventh CLI to the roster** (`origin/hermes-agent`), not to build a runtime.
They are a distro; a generation runtime is not their business.

That layer is precisely Cambium's: contracts, validation, repair, correctors,
grounding, budgets, sandboxed tools, traces, replay.

**Framing for any pitch:** Cambium is not a competitor to the agent roster and
should never be positioned as one. Agents are for open-ended work a human is
supervising. Cambium is for the jobs the *OS itself* needs done, where the
answer has a shape, the cost has a ceiling, and a wrong answer is visible.

**Realistic distribution posture:** build as a **plugin + AUR/community package**,
not as an upstream PR. Quattro's plugin system exists exactly for this ("you can
turn pieces of the desktop off, swap them out, or write your own without touching
a line of Omarchy's source"), and the distribution mechanism is a public git repo.
Plan for zero upstream merges; treat any as upside.

---

## 2.5 The driver's seat — agent ergonomics as the design axis (v2)

*This section reframes everything below it. The candidates in §5 are instances
of the pattern stated here, not a feature list.*

The human is not the primary operator of this integration. Omarchy's own design
already concedes this: the OS hands core dumps to an agent, budgets for agents
in the top bar, and symlinks its manual into five agents' skill directories.
The reader we are designing for is **the agent driving the machine on the
human's behalf** — any of the eleven, on any given day. An agent's scarce
resources are context tokens, verification effort, and trust; the integration
succeeds exactly to the degree it converts those from per-task costs into
system properties. Everything in this section is written from that seat:
*what would I need to understand the machine accurately and drive it to the
best result at the least spend?*

### 2.5.1 The tower

The system is one pattern, four layers, applied everywhere:

```
L4  DRIVER    the interactive agent (any of the roster)
              composes the layers below; owns ambiguity; talks to the human
L3  APPLIERS  deterministic mutations — Omarchy-owned, diffable, reversible
              omarchy theme set · menu overlay write · omarchy bar set …
L2  GENS      Cambium — typed proposals under contract
              returns schema · grounding · correctors · repair · budget · trace
L1  SENSORS   deterministic, machine-readable truth; zero inference
              omarchy commands --json · omarchy-theme-color --all ·
              notification journal · coredumpctl · pacman log
L0  STATE     files, configs, journals, dumps, wallpapers
```

Cross-cutting: **trace** (audit any L2 output after the fact), **memory**
(accretion across runs), **schedule** (autonomy, via the distro's own
`systemd-run` idiom — see §8.1), **notification** (surfacing to the human).

The load-bearing rule: **inference lives only in L2, and L2 only proposes.**
Sensors never guess; appliers never decide; gens never mutate. Every candidate
in §5 factors this way — theme = sense (extracted swatches) → propose (palette
gen) → apply (`omarchy theme set`); crash = sense (`coredumpctl`) → propose
(grounded report) → apply (file the issue, human-gated); menu = sense (current
overlay) → propose (validated entry) → apply (write + hot reload). Anything
that cannot be factored into this shape is either a driver job (L4) or not a
job at all — which is §3.2 restated structurally.

This is also the honest answer to "assemblage of parts": the parts *are* one
system precisely because they share this factoring, the same `/v1/run` core,
the same trace format, the same closed error enum, and the same on-disk run
artifacts. Coherence is not a diagram; it is the guarantee that anything I
learn about one gen (how to call it, how it fails, where its trace lives)
transfers to every other.

### 2.5.2 Doctrine, from the seat

**1. Propose, don't mutate.** Every shipped gen returns a proposal object; the
mutation is a separate, deterministic, previewable step. Shims take `--diff`
(render what would change) and `--apply`; print-only is the default. This
dissolves the manual's "be ready to rollback… if the agent makes a mess"
warning *structurally*: a wrong proposal costs nothing, I can always show the
human a diff before anything moves, and every gen in the catalog becomes safe
to call speculatively. Speculative composition is where an agent's leverage
lives.

**2. Self-description, or it doesn't exist.** As the driver I will not read
source to discover a capability — a capability that must be discovered by
reading is, for practical purposes, absent. The catalog must be enumerable
with schemas: per gen — description, input shape, `returns` JSON Schema,
budget ceiling, model tier, egress posture, one example invocation. (§5.9.)

**3. Speak tool, not prose.** The shim (§5.1) serves QML consumers; agents
deserve their own thin adapter over the same core: an MCP server that surfaces
each gen as a typed tool derived from its contract (§5.9). Then the roster
agents see the OS's gens *natively in their tool lists* — no shim knowledge,
no prompting, no prose parsing. One core, two doors, both transport-only.

**4. Typed failure end-to-end.** The closed `error.kind` enum must survive
every hop: the shim maps kinds to distinct exit codes (§6.7), the MCP adapter
returns them structurally. An agent that must parse prose to branch will
mis-branch; a closed enum makes recovery a table, not a judgment call —
`budget_exhausted` → ask the human, `output_ceiling` → raise `max_tokens` and
retry, `validation_failed` → read the trace.

**5. The trace is the explanation.** `run_id` is surfaced on every call,
success included; debugging means reading `runs/<id>/trace.json`, never
re-deriving. When the human says "the theme it made is ugly," I read the
trace, see the extracted swatches and the model's role assignments, and fix
the corrector or the prompt — I do not guess. `cambium replay` re-executes the
post-Generate tail against recorded output, so diagnosis is nearly free; with
`--mock` I can rehearse an entire pipeline at zero model spend. The system is
built so its own behavior is cheaper to *audit* than to *reproduce* — the
inversion that makes an agent trustworthy at the OS layer.

**6. Accretion through artifacts, not weights.** The loop: run → trace →
fixture → golden test → corrector. Every failure I fix becomes permanent
regression armor, legible and diffable in git. The missing rung is a one-move
capture — `cambium promote <run-id>` turning a real run into fixture +
snapshot (§6.8). And gens' memory slots accrete *machine-local* knowledge
("this user rejected saturated accents twice") without the driving agent
carrying it in context — the system personalizes in L2 state, not in my
window.

**7. Delegation economics.** The frontier agent's context is the most
expensive resource on the machine — roughly two orders of magnitude over a
local gen's tokens. Every shaped subtask I delegate returns ~50 tokens of
schema-guaranteed object instead of thousands of tokens of read-and-reason;
`budget` declares cost *before* the call, so spend is a plannable input rather
than a surprise; deterministic pre-passes (k-means in §5.2) do the parts that
need no model at all. The integration should make delegation the path of
least resistance because it is also the path of least spend — that is the
"agent-accretive" claim in one sentence: every gen the OS ships is a skill I
acquire with a contract I can trust without reading its implementation.

**8. A skill teaches the idiom.** Ship a `cambium` SKILL.md into the same
directories Omarchy already symlinks its own skill into (§5.10). It is the
bridge for agents that don't speak MCP, and the one place this section's idiom
is written down for its actual reader.

### 2.5.3 How Cambium disappears

"Transparent yet valuable" resolves the way SQLite resolved it: everywhere,
invisible, trusted. The human's surface is distro verbs — `omarchy theme
generate`, `omarchy menu add` — never vendor verbs. The agent's surface is
tools in its list and a skill in its directory. The name "Cambium" appears in
exactly three places: the usage tile (§5.3), the package name, and the trace
on disk. The measure of success is that plugin authors and roster agents use
typed generation daily without knowing or caring what runtime serves it — the
ecosystem position (§5.1) is won precisely at the point the brand becomes
unnecessary.

---

## 3. Evaluation criteria used for the tiering

Each candidate below is scored against:

1. **Visible failure mode.** Cambium's value is invisible unless the feature
   breaks loudly without it. A malformed hex colour breaks a desktop; a
   slightly-worse paragraph does not. *Prefer jobs where wrongness is obvious.*
2. **Shape.** Does the output have a schema? If the honest answer is "prose",
   it is an agent job, not a Cambium job.
3. **Fits the distro's idiom.** CLI prints JSON; QML reads it. Local models
   preferred. No new daemons the user didn't ask for.
4. **Dependency cost.** Omarchy is deliberately frugal. Every megabyte and every
   runtime we ask for is argued against us.
5. **Does not require upstream consent.**
6. **Agent-legible (v2).** Does it factor into sense → propose → apply
   (§2.5.1), and does it return a typed proposal the driving agent can trust
   *without re-verifying*? A capability an agent must read source to discover,
   or re-check after every call, has negative ergonomic value.

---

## 4. Recommendation summary

| # | Item | Tier | Effort | Needs upstream? |
|---|---|---|---|---|
| 5.1 | `cambium serve` as a shell `service` plugin — the typed LLM call for plugin authors | **1** | M–L | No |
| 5.2 | Theme generation from a wallpaper (wedge demo A) | **1** | S–M | No |
| 5.8 | `omarchy menu add` — typed menu-entry gen (wedge demo B, v2) | **1** | S–M | No |
| 5.9 | MCP adapter + self-describing catalog (v2) — the agent-facing door | **1** | S–M | No |
| 5.10 | The `cambium` skill for roster agents (v2) | **1** | S | No |
| 5.3 | `omarchy-agent-usage-cambium` collector | **1** | S | No |
| 5.6 | Packaging: AUR package + Ruby-free runtime mode | **1 (prereq)** | **S** (verified, §7.8) | No |
| 5.4 | `diagnose-crash` as a grounded gen, shipped *alongside* the skill | 2 | M | No |
| 5.5 | Other OS-owned gens + the command-catalog tool roster (v2) | 2 | varies | No |
| 6.8 | `cambium promote <run-id>` — run → fixture in one move (v2) | 2 | S | No |
| 5.7 | ~~Route the agent CLIs through Cambium's sandbox~~ | **Rejected** | — | Yes (won't get it) |

---

## 5. The candidates

### 5.1 — `cambium serve` as a Quattro `service` plugin  ⭐ the real idea

**What.** Ship `cambium serve` as a user systemd unit bound to a unix socket,
plus a `kind: "service"` Omarchy plugin and a thin `omarchy-cambium-run` CLI
shim. Any other plugin — first-party or third-party — can then get a
schema-validated object out of a model instead of parsing prose.

**Why it fits.** The shell is now one persistent process with a headless service
plugin kind, and there is no other way for a plugin to reach a model. This turns
"shell out to `claude --yolo` and hope" into `POST /v1/run` with a gen name and
a closed `error.kind` enum. It is an **ecosystem position, not a feature**: if
Cambium becomes how an Omarchy plugin calls a model, every plugin author on
omarchyplugins.com is a user.

**Sketch.**

```
~/.config/systemd/user/cambium.service
  ExecStart=cambium serve --workspace ~/.config/omarchy/cambium \
                          --bind unix:///run/user/%U/cambium.sock \
                          --max-inflight 4 --run-timeout 60

~/.config/omarchy/plugins/<user>.cambium/
  manifest.json          { schemaVersion: 1, kinds: ["service"],
                           entryPoints: { service: "Service.qml" } }
  Service.qml            health-watches the socket; exposes a callable singleton
                         that spawns the shim via Process {}

bin/omarchy-cambium-run <gen> <method> [--input -]
  → curl --unix-socket /run/user/$UID/cambium.sock -XPOST .../v1/run
  → prints the validated `output` object as one line of JSON, or exits non-zero
    with the `error.kind` on stderr
```

**Design notes.**
- `--bind unix://` is already supported and is the right call: filesystem
  permissions instead of a listening TCP port on a desktop machine. TCP loopback
  is the fallback only if a consumer genuinely can't spawn a process.
- The shim exists because QML has no HTTP client in the Omarchy idiom (§1.4).
  It also gives us one place to enforce timeouts and redact `error.message`.
- Health: `/v1/healthz` is never gated by `--max-inflight`, so the service
  plugin can probe a saturated server — good for a bar indicator.
- Socket must be under `/run/user/$UID` (0700), not `/tmp`.

**Open questions.** Where does the gens workspace live — a Cambium-owned
`~/.config/omarchy/cambium/` (user-editable, matches the clone-and-tweak
doctrine) or inside the package (immutable, but then user gens have nowhere to
go)? Probably both, with a documented precedence. Lazy start (socket activation)
vs. always-on: a resident Node process on a laptop is a battery argument we will
have to answer.

---

### 5.2 — Theme generation from a wallpaper  ⭐ the wedge demo

**What.** `omarchy theme generate <image>` → a complete, valid `colors.toml`,
via a Cambium gen with a typed `returns` block, hex + contrast correctors in the
repair loop, running on a **local** model (Ollama/oMLX are already first-class
in Cambium), no network egress, with a golden test under `--mock`.

**Why this one.** It is the best wedge available:

- **Fresh, real pain.** Quattro expanded the palette; a theme is now 26 keys
  hand-authored per theme (§8.2), across 22 shipped themes, and
  `manual/43-making-your-own-theme.md` exists because people do this.
- **Loudly visible failure mode.** `red = "not a colour"` is a broken desktop.
  An unreadable foreground-on-background pair is instantly obvious. This is the
  criterion in §3.1, satisfied maximally.
- **The output slot already exists.** `themes/<name>/colors.toml` is consumed by
  17 `default/themed/*.tpl` templates (alacritty, btop, chromium, foot, ghostty,
  helix, hyprland, kitty, neovim, obsidian, vscode, the shell itself — and
  `claude.json.tpl` / `pi.json.tpl`, since themes sync to the agents). We
  generate one small file; Omarchy propagates it everywhere.
- **It exercises the entire Cambium value prop in one demo**: `returns` (typed
  schema) → `corrects` (hex normalisation, contrast ratio) → repair loop →
  `budget` → local model → `--mock` golden test → trace. If someone asks "why
  not just prompt Claude for a TOML file", this is the artifact that answers.
- **Adversarial detail that sells it:** the palette is *asymmetric* — there are
  `bright_` variants for red/yellow/green/cyan/blue/magenta but **not** for
  `orange` or `brown`. A free-form prompt invents `bright_orange` roughly
  whenever it feels like it; a closed schema cannot.

**Sketch.**

```ruby
class ThemePalette < Cambium::GenModel
  model "ollama:<vision-capable-local>"     # local-first; no egress
  budget per_run: { max_tokens: 2_000 }

  returns do
    field :mode, String, enum: %w[dark light]
    field :accent, String
    field :selection, String
    field :muted, String
    field :background, String
    field :dark_background, String
    # ... 26 keys total, see §8.2
  end

  corrects :hex_normalize      # app corrector: "#7AA2F7"/"7aa2f7"/"rgb(...)" → "#7aa2f7"
  corrects :contrast_floor     # error-severity if fg/bg contrast < WCAG threshold
                               # → feeds the repair loop rather than shipping unreadable
end
```

**Scope note.** A theme directory is more than `colors.toml`: it also carries
`icons.theme`, `keyboard.rgb`, `neovim.lua`, `shell.lock.toml`, `vscode.json`,
`backgrounds/`, and preview PNGs. **v1 generates `colors.toml` only** and lets
the existing template machinery do the rest; the others are either copied from a
base theme or left to the user. Do not let scope creep into "generate a whole
theme" for the demo.

**Risk.** Needs a locally-runnable vision model to read a wallpaper, or a
non-LLM pre-pass (k-means dominant-colour extraction) feeding a text-only model
the extracted swatches. **The pre-pass is probably the better design anyway** —
it is deterministic, cheap, and leaves the model doing the part it is actually
good at: assigning extracted colours to semantic roles and filling gaps. Decide
this early; it changes the model requirement completely.

---

### 5.3 — `omarchy-agent-usage-cambium` collector

**What.** A collector that reads `runs/*/trace.json` and prints one
display-ready JSON record: tokens by model, spend, run counts, budget-exhaustion
events, repair-loop attempts.

**Why.** Omarchy *documented this extension point in a source comment* (§1.2).
It is perhaps 200 lines. It puts Cambium in the OS's AI panel next to Claude and
Codex with zero architectural argument and zero upstream consent. Cheapest
visibility available.

**Caveat.** The panel's mental model is *subscription rate limits* — plan,
percentage of the 5-hour session burned, weekly limits. Cambium has no
subscription; it has local spend. The record has to map honestly onto the
panel's shape or it will render as a broken tile. Worth reading
`shell/plugins/agents/Agent.qml` + `Panel.qml` closely before committing to a
record shape — a "local generation spend" tile may need its own small panel
rather than pretending to be a subscription.

---

### 5.4 — `diagnose-crash` as a grounded gen (alongside, not instead of)

**What.** A `CrashReport` gen: `grounded_in` the backtrace + journal excerpt with
verbatim quote verification, `returns` a typed report (suspect frame, package,
signal, confidence, `should_report_upstream: Boolean`, a formatted issue body).

**Why it is the strongest *technical* case in the document.** `grounded_in` with
quote verification means **the report cannot cite a stack frame that is not in
the core dump.** A hallucinated frame in a crash report is worse than no report:
it sends the user upstream to file a bug against the wrong package. This is
exactly the failure a markdown skill cannot prevent and a verified-quote
contract structurally can.

**Why it is Tier 2 anyway.** The current skill works with *any* of the eleven
agents. That portability is a deliberate design constraint Omarchy will defend,
and our version only works if Cambium is installed. **Do not pitch this as a
replacement.** Ship the gen as the enforcement path for users who have Cambium,
leave the markdown skill as the universal fallback, and let the quality
difference make the argument.

---

### 5.5 — Other OS-owned gens (candidate menu, unranked)

Filtered by §3 criteria; each has a shape and a visible failure mode:

- **`pacman`/update failure explanation** — typed `{ cause, offending_package,
  suggested_command, safe_to_retry }`. Grounded in the actual pacman output;
  the suggested command is validated against a closed allowlist, not free-form
  shell. (Hook point: `post-update`.)
- **`omarchy debug` report summarisation** — structured hardware/config summary
  with a bounded token budget, suitable for pasting into an issue.
- **Migration-failure triage** — migrations are sourced bash; a failure is
  currently silent-ish. Typed `{ migration_id, failed_step, recoverable }`.
- **Commit-message / release-note drafting for `omarchy dev`** — schema'd,
  cheap, local.
- **Keybinding conflict explanation** — deterministic detection, model only for
  the human-readable rendering.

**v2 — the tool roster is already written.** `omarchy commands --json` is a
machine-readable catalog of the distro's ~450 CLI commands — the router parses
`# omarchy:key=value` headers into route, binary, group, flags, args,
examples, and aliases, and `omarchy commands --check` lint-enforces the
metadata in `test/cli` (`bin/omarchy`, `docs/cli-router.md`). Two
consequences. First, the pacman gen's "closed allowlist" above already exists
— it *is* the catalog. Second, and further out: an OS-task gen in
`mode :agentic` can have its entire tool roster *generated* from the catalog
and run under Cambium's deny-by-default `uses`, per-run `budget`, and full
trace — a bounded OS agent, which is the middle path §5.7 correctly refuses
to reach by wrapping third-party binaries. We own both ends here. This is the
long-game platform story behind the menu of one-offs above.

**v2 — every gen gets a UI for free.** Every notification is journaled as JSON
under `~/.local/state/omarchy/notifications/`, and `omarchy-notification-send
--exec <program>` attaches a clickable action (`docs/notifications.md`). Wire
gen signals (`extract` + `on`) to it: the crash gen finishes → critical
notification "Crash diagnosed: suspect libfoo — click for report." The
journal is also a watchable, grounded corpus for a typed "what happened while
I was away" digest gen. This is the tower's **notification** cross-cut
(§2.5.1) made concrete, in the distro's own idiom.

Explicitly *not* candidates: anything whose honest output is prose with no
shape. Those are agent jobs. Handing them to Cambium would be using the wrong
tool to make a point.

---

### 5.6 — Packaging (prerequisite for everything above)

**The Ruby problem.** Asking a deliberately frugal distro to install **Node *and*
Ruby** to get a theme generator is a losing pitch, and it is the first objection
anyone will raise.

**The answer is the IR.** Cambium's compile step is Ruby; its *runtime* is Node
reading `ir.json`. So:

> **Precompile the IR at package-build time and ship the JSON. The target
> machine needs only Node.**

This reframes "install a Ruby toolchain" into "ship a data file", and it should
be treated as a **first-class, documented distribution mode**, not a trick —
"Cambium apps ship as compiled IR; Ruby is a build-time dependency" is a good
property for every embedded/OS/appliance context, not just this one. It is
probably the single most strategically valuable engineering item in this
document, because it is reusable far beyond Omarchy.

Consequences to work through: `cambium run` currently compiles from
`.cmb.rb`; a precompiled-IR path needs a supported entry point (`cambium serve`
already loads a workspace, so this may mostly exist). Users writing *their own*
gens would still need Ruby — that is fine and should be stated: consuming
shipped gens needs Node; authoring gens needs Ruby.

**Package shape.** AUR package `cambium` (or `cambium-bin`) depending on
`nodejs`; optional `cambium-omarchy` carrying the plugin + shim + systemd unit +
the shipped gens as precompiled IR. Note Omarchy's own repo is currently
`SigLevel = Optional TrustAll` — do not treat their repo signing posture as a
model for ours; given Cambium's supply-chain doctrine (`SECURITY.md`), we should
sign.

---

### 5.7 — Rejected: routing the agent CLIs through Cambium's sandbox

**The idea.** Omarchy launches eleven agents with every gate off. Cambium has
deny-by-default exec, egress allowlists with fetch-time enforcement, budget
pre-call gates, and Firecracker/WASM substrates. Wrap them.

**Why it is rejected.**
1. Those are third-party binaries we do not control. Wrapping them means
   intercepting their tool dispatch, which we cannot do from outside.
2. Low-ceremony trust is the *design*, not an oversight. `--yolo` is chosen, not
   accidental. Arguing against it is arguing with the distro's taste, and we
   lose that argument on their turf.
3. It would position Cambium as a competitor/critic of the agent roster, which
   is exactly the framing to avoid (§2).

**What to do instead.** Apply the safety machinery to the prompts *the OS
itself authors* (§5.4, §5.5), where we own both ends. That gets the security
value without the fight.

---

### 5.8 — `omarchy menu add`: typed menu-entry gen (v2)  ⭐ wedge demo B

**What.** A gen that turns "add a menu entry that opens my notes in Obsidian"
into a validated patch to `~/.config/omarchy/extensions/omarchy-menu.jsonc` —
typed `returns` matching the menu entry schema, plus a corrector that runs the
**actual consumer** against the merged result before anything is written:
`shell/plugins/menu/MenuModel.js` is pure, Node-loadable JS, so the corrector
executes the real parser, not a re-implementation. Apply step: write the
overlay file; the shell hot-watches it, so feedback is instant and no restart
is involved.

**Why.** The menu overlay is the primary user-facing customization surface,
and it is fragile in precisely the way Cambium fixes (`docs/menu.md`):

- Entry *kind* is inferred — has `action` → action, has `target` → link, else
  submenu — so a malformed entry silently becomes the wrong thing.
- Parenting is inferred from dotted ids.
- `when` / `checked` / `disabled` are embedded bash conditions.
- The parser strips only whole-line `//` comments; **an inline trailing
  comment fails the parse, and "a file that fails to parse contributes no
  entries"** — every user entry vanishes, silently.

Against §5.2: smaller schema, faster feedback loop (hot reload vs. theme
propagation), and today's failure mode is *silent* rather than loud —
arguably the worse of the two. It also scores maximally on §3.6: the proposal
is verified by executing the target system's own code, which is the strongest
form of "trust without re-verifying" available.

**Relation to §5.2.** Build both; they sell different halves of the runtime.
Theme gen shows the repair loop healing *semantic* wrongness (contrast, role
assignment); menu gen shows a proposal validated against ground truth by
running the consumer. Whichever ships first is the wedge; the other is the
proof that it's a pattern, not a trick.

---

### 5.9 — MCP adapter + self-describing catalog (v2)  ⭐ the agent-facing door

**What.** Two thin adapters over the same `/v1/run` core:

1. **Catalog self-description.** A `/v1/gens` route (additive — the `/v1`
   promise permits new routes) or an enriched healthz, returning per gen:
   description, input shape, `returns` JSON Schema, budget ceiling, model
   tier, egress posture, one example invocation. Mirrored by
   `omarchy-cambium-run --catalog` for shell consumers.
2. **MCP server.** `cambium mcp --workspace <path>`, speaking MCP over stdio,
   exposing each catalogued gen as one typed tool whose input/output schemas
   derive from the contract. Every roster agent that speaks MCP then sees the
   OS's gens natively in its tool list — no shim knowledge, no prompting, no
   prose parsing (§2.5.2 #3).

**Why Tier 1.** §5.1 claims the position with plugin authors; this claims it
with the agents themselves — the larger and more active population of callers
on an Omarchy box (§2.5). It converts every shipped gen into an ambient
capability for eleven agent CLIs at once, and it is the piece that makes the
whole integration *agent-accretive* rather than merely agent-accessible.

**Dependency note.** MCP is JSON-RPC over stdio; the needed subset
(`initialize`, `tools/list`, `tools/call`) is small and stable. Implement
against `node:readline` / raw stdio with **no SDK dependency** — the
supply-chain doctrine (`SECURITY.md`) applies to this package like any other.

**Sequencing.** Catalog first: the shim (§5.1), the skill (§5.10), and the
MCP server all consume it. MCP is a thin layer on top.

---

### 5.10 — the `cambium` skill for roster agents (v2)

**What.** A SKILL.md shipped into the same directories Omarchy already
symlinks its own skill into (`~/.claude/skills`, `~/.codex/skills`,
`~/.pi/agent/skills`, …), teaching the driving agent: the tower and the
propose/apply idiom (§2.5), how to enumerate the catalog, the shim's
exit-code table (§6.7), where run artifacts live and how to read a trace, and
`cambium replay` / `--mock` for near-free diagnosis and rehearsal.

**Why.** It is the bridge for agents that don't speak MCP, and the one place
the integration's idiom is written down for its actual reader. Costs a
markdown file, distributed exactly the way the distro already distributes
agent knowledge. Generate and CI-validate it *from the catalog* (§5.9) so it
cannot drift — a skill that lies to an agent is worse than no skill.

---

## 6. Cross-cutting engineering requirements

### 6.1 Precompiled-IR distribution mode
See §5.6. Highest-leverage item; unblocks everything and pays off outside
Omarchy. Should be specced separately as its own ticket.

### 6.2 The I/O idiom is non-negotiable
CLI prints JSON → QML reads it (`Process`/`FileView`). Zero `XMLHttpRequest` in
the entire first-party shell. Any design where QML talks HTTP directly is
swimming upstream and will look foreign in review.

### 6.3 Socket, not port
`unix:///run/user/$UID/cambium.sock`. A desktop integration that opens a TCP
listener — even loopback — is a worse story and invites an argument we do not
need to have.

### 6.4 Version pinning against a three-week-old API
`schemaVersion: 1` shipped 2026-08-14 and **will churn**. Pin, validate with
`omarchy plugin validate` in CI, and expect to chase it. Also: `omarchy update`
routes through pacman with migrations — a plugin that breaks on an Omarchy
update is a support burden we own.

### 6.5 Local-first by default
Every gen shipped for the OS should default to a local model (Ollama/LM Studio
are both recommended in `manual/17-ai.md`, so the substrate is already blessed)
with **no network egress**, and make any hosted-model usage an explicit opt-in.
An OS feature that silently bills the user's Anthropic subscription to recolour
their desktop is a bad citizen and a bad headline.

### 6.6 Propose/apply is the uniform contract (v2)
Every shipped gen returns a proposal; every shim takes `--diff` and `--apply`,
with print-only as the default (§2.5.2 #1). No exceptions — a single gen that
mutates directly poisons the trust that makes speculative composition safe,
for the driving agent and the human alike.

### 6.7 Exit codes mirror `error.kind` (v2)
`omarchy-cambium-run` maps the closed `error.kind` enum to a stable table of
distinct exit codes (0 = ok, 1 = generic/unmapped, then one per kind),
documented in the skill (§5.10). Bash callers and agents branch on the code;
nobody parses stderr. Additive kinds get new codes; existing codes never
renumber — same additivity discipline as the wire format itself.

### 6.8 `cambium promote <run-id>` (v2 — spec as its own Cambium ticket)
One command to capture a real run as fixture + golden snapshot (§2.5.2 #6):
input document(s) → `examples/fixtures/`, recorded output → snapshot,
deterministic under `--mock`. Closes the accretion loop — a failure fixed in
the field becomes regression armor in one move. Like §5.6, this pays off far
beyond Omarchy and should be ticketed independently of any Omarchy decision.

---

## 7. Risks and open questions

1. **Test environment — decided: VM, and not yet.**

   Almost nothing in §5 can be developed on 3.8.5 — the Quickshell shell, the
   plugin system, and the agents panel simply do not exist there, and the theme
   schema is not merely smaller but *differently shaped* (§8.2). So Quattro is
   required for the desktop-facing work.

   But the first two deliverables do not touch Omarchy at all:
   - **§5.6 precompiled-IR mode** is pure Cambium work in this repo.
   - **§5.2 theme generation** is a Cambium gen whose only Omarchy dependency is
     the `colors.toml` schema — already extracted in §8.2, so it can be built,
     corrected, and golden-tested here against a fixture, with zero Omarchy
     present.

   **Therefore: stand up nothing now.** Build those two against a fixture; bring
   up a Quattro VM at the point the plugin work (§5.1/§5.3) starts, which is
   also the point a *disposable* machine earns its keep — `omarchy plugin add`
   from clean, package install/uninstall, and rollback are all things you want
   to run repeatedly and cannot rehearse on a daily driver.

   Upgrade the working machine later, once there is something worth living with.
   When that happens: Quattro moves system files from the
   `~/.local/share/omarchy` git checkout to pacman-managed `/usr/share/omarchy`,
   so **clone `basecamp/omarchy` to a working directory first** — the `git show`
   workflow behind §8.1 depends on it.

   *VM gotcha:* Hyprland + Quickshell need working GPU acceleration. Use QEMU
   with virtio-gpu (venus/virgl) rather than plain software rendering, or the
   desktop is unusable for the visual verification Omarchy's own `AGENTS.md`
   requires ("always take and analyze a screenshot after applying the change").

2. **Upstream posture is unknown and should be assumed unfavourable.** Build
   plugin-first. Any merge is upside, not plan.
3. **Resident Node process on a laptop.** Battery/RAM objection is legitimate.
   Investigate socket activation / lazy start before committing to always-on.
4. **The agents-panel record shape** may not fit a non-subscription producer
   (§5.3). Read the QML before designing the record.
5. **Vision model requirement for theme generation** may evaporate entirely with
   a deterministic colour-extraction pre-pass (§5.2). Resolve early — it changes
   the dependency story.
6. **Cambium 0.9.1 roadmap contention.** None of this is on the current
   roadmap. This is a strategic side-bet; it needs an explicit decision about
   whether it competes with 1.0 work or waits behind it.
7. **Name/namespace.** `omarchy.*` is reserved; our plugin id must be
   `<user>.cambium` or `redwood.cambium`. Trivial, but decide it once.
8. **(v2) §5.6 is smaller than v1 feared.** Verified in the Cambium repo:
   engine mode already materializes `<gen>.ir.json` at build time
   (`cli/compile.mjs`), and `runGenFromIr` consumes IR with no Ruby anywhere.
   The gap is only (a) a precompiled-IR boot path for `cambium serve`, which
   today spawns `ruby compile.rb` per catalog entry at boot, and (b) a
   `cambium run` form that accepts an `.ir.json`. CLI plumbing over an
   existing runtime capability — estimate S, not M. The "Ruby is a build-time
   dependency" framing in §5.6 stands, now with lower risk.

---

## 8. Appendix

### 8.1 Evidence index

All paths relative to the Omarchy repo at `origin/quattro` @ `7d58bb9a`.

| Claim | Where |
|---|---|
| Agent launcher, permission-bypass flags | `bin/omarchy-agent` |
| Prompt path | `bin/omarchy-agent-prompt` |
| Crash handoff | `bin/omarchy-agent-crash` |
| Agent roster + mise install | `bin/omarchy-default-agent` |
| Usage collector contract | `bin/omarchy-agent-usage-update` |
| Claude usage collector | `bin/omarchy-agent-usage-claude` (Python) |
| Usage panel reads JSON only | `shell/plugins/agents/Main.qml` |
| Agents manifest + settings schema | `shell/plugins/agents/manifest.json` |
| Plugin validator (path safety, no symlinks) | `bin/omarchy-plugin-validate` |
| Plugin kinds, IPC, clone semantics | `shell/README.md`, `manual/32-shell-plugins.md` |
| First-party plugin inventory | `shell/plugins/README.md` |
| AI surface, local LLM stance, skill caveat | `manual/17-ai.md` |
| Hook runner + verified event names | `bin/omarchy-hook` |
| Theme palette schema | `themes/<name>/colors.toml` |
| Theme consumers | `default/themed/*.tpl` (17 templates) |
| Contributor conventions | `AGENTS.md`, `agents/skills/*.md` |
| 11th agent (unmerged) | `origin/hermes-agent` |
| Menu overlay, inferred kinds, fragile parser (v2) | `docs/menu.md`, `shell/plugins/menu/MenuModel.js`, `default/omarchy/omarchy-menu.jsonc` |
| CLI command catalog, `omarchy commands --json` (v2) | `bin/omarchy`, `docs/cli-router.md`, `agents/skills/command-metadata.md` |
| Notification journal + `--exec` actions (v2) | `docs/notifications.md`, `bin/omarchy-notification-send`, `bin/omarchy-done` |
| Theme template DSL + user `.tpl` override dir (v2) | `bin/omarchy-theme-set-templates`, `config/omarchy/themed/*.sample` |
| Transient-timer scheduling idiom, no cron (v2) | `bin/omarchy-reminder` |
| `colorN` alias synthesis, legacy compat (v2) | `bin/omarchy-theme-color` |
| `pi` / `ori` launch with no bypass flag (v2) | `bin/omarchy-agent` |

### 8.2 The real `colors.toml` schema (from `themes/tokyo-night/colors.toml`)

26 keys: 1 mode + 25 colours. Note the missing `bright_orange` / `bright_brown`.

```toml
mode = "dark"                    # dark | light

accent, selection, muted                                          # 3
background, dark_background, darker_background, lighter_background # 4
foreground, dark_foreground, light_foreground, bright_foreground   # 4
red, yellow, orange, green, cyan, blue, magenta, brown             # 8
bright_red, bright_yellow, bright_green,
bright_cyan, bright_blue, bright_magenta                           # 6
```

**This is a rename, not an expansion.** 3.8.5 used 6 named keys (`accent`,
`cursor`, `foreground`, `background`, `selection_foreground`,
`selection_background`) plus `color0`–`color15`; Quattro has **no `colorN` keys
at all**, only semantic roles. Two consequences: any 3.8.5-era theme knowledge
is stale, and the new schema is markedly *better suited to generation* — a model
can reason about "the bright variant of red" and cannot meaningfully reason
about `color9`. It also means themes are no longer a flat 16-colour terminal
palette but a semantic design system, which is a harder authoring job for a
human and an easier one for a typed gen.

Sibling files in a theme dir: `icons.theme`, `keyboard.rgb`, `neovim.lua`,
`shell.lock.toml`, `vscode.json`, `backgrounds/`, `preview.png`,
`preview-unlock.png`, `unlock.png`.

**v2 caveat:** `bin/omarchy-theme-color` still synthesizes `color0`–`color15`
aliases in both directions, so legacy `colorN` consumers keep working even
though no shipped theme defines them. The generation target stays the 26
semantic keys; the alias layer is free backward compatibility, which
strengthens rather than complicates §5.2. Any external tool should call
`omarchy-theme-color` rather than re-parsing `colors.toml`.

### 8.3 Cambium `/v1` serve surface (for §5.1)

```
POST /v1/run   { gen, method, input, memory_keys?, fired_by?, include_trace? }
  200 → { ok: true,  run_id, output, trace }
      → { ok: false, run_id, error: { kind, message, details } }
GET  /v1/healthz → { status, gens[], version }   # never rate-limited

error.kind (closed in v1): unknown_gen | unknown_method | input_invalid |
  validation_failed | budget_exhausted | tool_dispatch_failed | runner_error |
  timeout | overloaded | booting | not_found | output_ceiling

Binds: tcp://127.0.0.1:PORT | unix:///path.sock | pipe://name
Flags: --max-inflight, --run-timeout, --shutdown-timeout, --allow-remote
```

Note `error.message` may carry reflected prompt fragments from provider 400s
(documented in `C - Serve Mode`); the shim in §5.1 should not surface it raw.

### 8.4 Suggested next decisions (updated v2)

1. Is this a side-bet to spec now and build after 1.0, or does it compete?
   (§7.6) — Sharpened by v2: three of the tickets (§5.6 precompiled IR, §6.8
   promote, §5.9 catalog self-description) are Cambium-generic and
   1.0-adjacent regardless of Omarchy; only the plugin/VM work is truly
   Omarchy-specific spend.
2. ~~Precompiled-IR mode — spec as its own ticket regardless?~~ **Yes —
   verified S-sized (§7.8). Spec it.**
3. ~~Vision model, or deterministic colour extraction + text model?~~
   **Default (v2): deterministic k-means pre-pass + text model.** Removes the
   vision-model dependency, makes the golden test stable, and leaves the model
   doing semantic role assignment — the part it is good at. Reopen only if the
   pre-pass demonstrably under-serves dark/duotone wallpapers.
4. ~~Quattro VM or upgrade?~~ **Decided: VM, deferred.** The first
   deliverables need no Omarchy at all (§7.1).
5. First artifact: a wedge demo — §5.2 or §5.8, whichever fixture is ready
   first — with the §5.9 catalog built alongside, since the shim, the skill,
   and the MCP adapter all consume it. §5.1 claims the position once there
   are gens worth calling; a service plugin with an empty catalog is an empty
   socket.
6. ~~Which wedge leads — theme (§5.2) or menu (§5.8)?~~ **Decided
   (2026-09-01): theme leads.** It is how Cambium becomes tangible yet
   frictionless — tangible because one generated file recolors every surface
   through the 17 templates; frictionless because it is one command, a local
   model, no account, and propose → diff → apply. Menu (§5.8) ships second as
   the proof it's a pattern. The theme demo's definition of done includes a
   screencastable artifact (wallpaper in → recolored desktop out, plus one
   trace shot of a contrast violation caught and repaired).

---

## 9. External sources

- Omarchy Quattro PR — https://github.com/omacom/omarchy/pull/6231
- Code To Cloud, "Omarchy 4 Quattro: What's New" — https://codetocloud.io/blog/omarchy-4-quattro-whats-new/
- DevOps Daily, "Omarchy 4 Makes the Linux Desktop Feel Like a Product" — https://devops-daily.com/posts/omarchy-4-quattro-developer-workstation
- Primary source: `origin/quattro` @ `7d58bb9a` in `~/.local/share/omarchy`
