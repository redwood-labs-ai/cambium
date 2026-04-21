## Note: Scheduled Gens — `cron` Primitive

**Doc ID:** gen-dsl/note/scheduled-gens
**Status:** Shipped — RED-305
**Last edited:** 2026-04-21

---

## Purpose

Cambium gens today are single-invocation: `cambium run <file> --method X --arg Y` executes one dispatch, exits. That's wrong for a large class of real gen shapes — daily digests, periodic pulls, scheduled analysis, maintenance jobs. These shapes are exactly what n8n, Zapier, and Airflow exist for, and they're explicit targets for Cambium ("replace your n8n workflow with a gen, without learning cron or k8s").

This note specs a `cron` primitive that closes the gap. Two things have to be true at once:

1. **Cambium owns the semantics of scheduled runs** — memory scope across fires, idempotency keys for triggers, observability fields, compile-time validation. These are gen-first concerns that Cambium's primitives already reach into; adding scheduling forces the question of how they compose.

2. **Cambium does NOT own the lifecycle** — no long-running daemon, no supervisor, no missed-fire recovery. The operator's existing scheduler (crontab, k8s CronJob, Render cron, systemd timer, GitHub Actions `schedule`) owns the "when." Cambium compiles declarations to deploy-ready manifests.

This is the Rails `whenever` gem pattern moved inside the framework.

---

## Grounding

Curator-class use cases that force the primitive:

- **Daily pattern-bank refresh.** Morning gen re-scans the corpus, updates the pattern library, writes a summary to the team Slack.
- **Weekly audit report.** Sunday-morning gen reads last-week's signals, writes the compliance digest.
- **Periodic pulse checks.** Hourly gen polls a handful of repos for suspicious commits, routes findings via the trigger system.
- **Maintenance.** Nightly memory-bucket prune, trace-log rollup, expired-cache eviction.

External schedulers already handle "fire this process at 9am." What they don't handle, and what the primitive must: "remember yesterday's top finding," "don't double-notify if the scheduler retries," "distinguish a scheduled run from an ad-hoc one in the trace and logs."

---

## Decisions

### 1. Mechanism: declaration + runtime semantics + compile-to-artifact

Cambium owns:
- The *declaration* (`cron :daily` on a GenModel).
- The *IR representation* (`policies.schedules[]`).
- The *runtime semantics* (memory scope, `fire_id`, observability tags) when a run claims to be a scheduled fire via `--fired-by`.
- The *compile step* that emits deploy-ready manifests for the operator's scheduler of choice.

Cambium does NOT own:
- A long-running scheduler process.
- Missed-fire recovery or retry logic.
- Distributed coordination.

See rejected alternatives for the daemon path.

### 2. DSL shape

```ruby
class MorningDigest < Cambium::GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :morning_digest
  returns DigestReport

  # Named vocabulary — most common cases.
  cron :daily, at: "9:00"

  # Raw crontab for anything the vocabulary doesn't cover.
  # cron "30 14 * * 1-5"

  # Multi-schedule gen: separate method entries, different schedules.
  # cron :daily, method: :morning, at: "9:00"
  # cron :daily, method: :evening, at: "18:00"

  # Explicit id for stable manifest identity when authors prefer control.
  # cron :daily, at: "9:00", id: :morning_report

  memory :history, scope: :schedule, strategy: :sliding_window, size: 30
  log :app_default

  def analyze(input)
    generate "summarize yesterday's signals" do
      with context: input
      returns DigestReport
    end
  end
end
```

**Named vocabulary to ship v1:** `:daily`, `:hourly`, `:weekly`, `:weekdays`, `:every_minute` (for testing). Keep the core set small; extend on real requests.

**Raw crontab** accepted as a string for anything not covered by the vocabulary — standard 5-field crontab syntax.

**Future** (not v1): `:market_hours`, `:business_days`, quarter-based, etc. Stay opinionated; every addition to the vocabulary commits the framework to semantic stability.

### 3. Schedule IDs — auto-generated, stable

Shape: `<snake_gen>.<method>.<slug>`.

- `<snake_gen>` — snake-cased class name (`PatternExtractor` → `pattern_extractor`).
- `<method>` — the method entry (default: first `def` on the class, or explicit `method:` opt).
- `<slug>` — the named-vocab token (`daily`) or a short hash of the crontab expression (`cron_a3f2`).

Examples:
- `morning_digest.analyze.daily`
- `market_scanner.pulse.hourly`
- `compliance_report.weekly_audit.cron_a3f2` (raw crontab)

Author can override: `cron :daily, id: :morning_report` → `morning_digest.analyze.morning_report`.

IDs are stable across compiles so scheduler manifests don't thrash. The regex `/^[a-z][a-z0-9_.]*$/` is enforced (path-traversal guard, parallel to RED-214 / RED-215 name rules; `.` allowed here because IDs are composite identifiers, not filesystem paths).

### 4. Runtime flag: `--fired-by`, default absent (interactive)

```bash
cambium run app/gens/morning_digest.cmb.rb \
  --method analyze \
  --fired-by schedule:morning_digest.analyze.daily@2026-04-22T09:00:00Z
```

Env-var equivalent: `CAMBIUM_FIRED_BY=schedule:<id>@<iso_ts>` (crontab-friendly — crontab entries often don't carry CLI args cleanly).

Absent flag = interactive run. Default is unambiguous; no magic detection of parent processes.

The runner validates the schedule ID against `ir.policies.schedules[]` on startup. Unknown IDs are a hard error — catches typos in cron manifests before the gen runs.

Timestamp in the flag is optional. If absent, the runner stamps `Date.now()`. Operators who want their scheduler to pass the actual scheduled time (so `fire_id` reflects intent, not dispatch time) pass it explicitly.

### 5. Semantic unlocks (what `--fired-by` enables)

#### 5a. Memory scope `:schedule`

New scope value on `memory` declarations:

```ruby
memory :history, scope: :schedule, strategy: :sliding_window, size: 30
```

- Bucket keyed by the schedule ID. All fires of `morning_digest.analyze.daily` share one `history` bucket.
- `:session` unchanged — still "one run is one session."
- **Compile-time validation:** a gen with `scope: :schedule` MUST declare at least one `cron`. Otherwise the scope has no identity. Clear `CompileError`.
- **Runtime validation:** a gen with `scope: :schedule` invoked interactively (no `--fired-by`) fails fast with a clear error: "this gen expects a scheduled fire; pass `--fired-by schedule:<id>` or run through your cron."

#### 5b. `ctx.fire_id` on trigger actions

Each scheduled fire generates a `fire_id` — unique per fire, deterministic from the flag:

```
fire_id = "<schedule_id>:<iso_timestamp>"
```

Trigger action handlers receive it as `ctx.fire_id`:

```ts
// app/actions/slack_notify.action.ts
export const execute = async (input, ctx) => {
  const dedupe = ctx.fire_id ?? `interactive:${ctx.run_id}`;
  // Slack supports idempotency keys; use `dedupe` so scheduler retries don't double-post.
};
```

Framework provides the key. Action authors use it. Interactive runs fall back to `interactive:<run_id>` — same uniqueness property, different prefix for greppability.

Cambium does NOT build framework-level exactly-once delivery. That's a distributed-systems problem and varies by target system (Slack, webhooks, email). The framework's contribution is a *stable dedupe key*; the action's contribution is wiring it through the external API.

#### 5c. `trace.fired_by` field

Every run's `trace.json` carries `fired_by` when `--fired-by` was set:

```json
{
  "fired_by": "schedule:morning_digest.analyze.daily@2026-04-22T09:00:00Z",
  "steps": [ ... ]
}
```

Interactive runs omit the field. Trace-reader tooling can filter on presence.

#### 5d. RED-302 log integration

Log events automatically include `fired_by` in `ddtags` for scheduled runs:

```
ddtags: gen:morning_digest,method:analyze,event:complete,ok:true,fired_by:schedule
```

DD filter `@fired_by:schedule AND @ok:false` → "every scheduled-run failure across every gen, last 24h." For operations teams, this is the primary value-add of framework-level cron semantics vs. raw infrastructure crontab.

### 6. Compile-to-artifact

Shipped as `cambium schedule compile <workspace> --target <target>` (subcommand form, not a flag on `cambium compile`). Walks the workspace, for each `cron` declaration emits a deploy-ready manifest invoking `cambium run ... --fired-by schedule:<id>`.

**v1 targets:**

| Target | Output |
| --- | --- |
| `k8s-cronjob` | `<gen>-<slug>.cronjob.yaml` — one file per schedule, `apiVersion: batch/v1` |
| `crontab` | One line per schedule to stdout (redirect to `cron.d/cambium` or pipe to `crontab -`) |
| `systemd` | Paired `<gen>-<slug>.service` + `.timer` units |
| `github-actions` | `.github/workflows/<slug>.yml` with `on: schedule:` |
| `render-cron` | Cron-job block snippets for `render.yaml` |

Each target is ~30–50 LOC in the compiler. Users ask for more targets (Fly.io cron, Railway cron, Nomad periodic, etc.) as they land.

**Why five targets v1:** covers the vast majority of platforms vibe-coders and small-team operators reach for. Render/Railway/Fly + k8s + GH Actions spans free-tier hosts through enterprise k8s. systemd/crontab covers bare VPS.

### 7. Dev ergonomics (all static, no daemon)

- `cambium schedule preview <gen>.cmb.rb` — read IR, parse cron expressions, print next 5 fires. Pure computation.
- `cambium schedule list` — walk workspace, print all schedules with IDs + expressions.
- `cambium run --fired-by schedule:<id>@<timestamp>` — already covered by #4 but also supports simulating a scheduled fire with a custom "now" for DST / month-end edge cases.

All three are operations on the IR or cron-expression math. Zero runtime lifecycle.

### 8. Pair with RED-241 (prior-run state)

Scheduled gens force the prior-run-state question: "read yesterday's top finding as this run's context." RED-241 captures the answer: most of it collapses into memory + retro agents. A retro agent writes the run's top signal to a memory slot scoped `:schedule`; the next fire reads that slot.

The two tickets ship together because:
- RED-273's `scope: :schedule` is the concrete shape for RED-241's "prior-run bucket" requirement.
- RED-241's forcing case is RED-273's scheduled-fire pattern.

Neither makes sense alone: `scope: :schedule` without a way to write prior-run state into it is an empty bucket; retro agents writing to memory without a durable scope is a solved problem for session-scoped gens only.

---

## Rationale

### Why compile-to-artifact, not a daemon

**Rails's history is the strongest single signal.** Rails never owned a scheduler until Solid Queue Cron in Rails 8 (2024) — and even then, it piggybacks on the worker process users were already running for job processing, not a dedicated daemon. The canonical pre-Solid-Queue pattern (`whenever` gem) compiles Ruby → crontab. 15+ years of Rails apps proved this pattern works.

**Every major deployment target already has a scheduler.** Render, Railway, Fly, Heroku, k8s, bare VPS with systemd/crontab, GitHub-native, Vercel cron. The "no cron available" platform is vanishingly rare in 2026. Shipping a Cambium daemon duplicates work these platforms have already solved with better durability guarantees than a homegrown process.

**Operational surface a daemon commits to:** crash recovery, memory leaks over long uptimes, file-watch semantics when gen files change, dependency updates mid-run, healthcheck endpoints, graceful shutdown during deploy, distributed coordination at scale. Each solvable; together a platform, not a feature.

**Reversibility is the kicker.** Compile-to-artifact is the lower-commitment bet. If user feedback says "I want `cambium serve` — I don't want to touch render.yaml," adding a new `--schedule-target=cambium-serve` option alongside the others is additive work. The primitive, IR, and runtime semantics stay identical. The reverse — shipping a daemon and discovering 90% of users deploy to k8s anyway — is wasted work that still has to be maintained.

### Why named vocabulary + raw crontab, not just crontab

Named vocabulary (`:daily`, `:hourly`, etc.) gives the vibe-coder the cleanest authoring experience. Most gens don't need the full crontab expressiveness; `cron :daily, at: "9:00"` is what 80% of gens want. Raw crontab is the escape hatch for the 20% (`"30 9 * * 1-5"` for weekday-only 9:30am).

Keeping the vocabulary small is deliberate. Every named token commits Cambium to semantic stability — if `cron :market_hours` ships, the framework owns the definition of "market hours" (NYSE? ET? holidays?) for years. Ship the truly universal terms; let authors fall back to raw crontab for the rest.

### Why `--fired-by` as an explicit flag

The alternative — detecting "am I running under cron?" via parent-process heuristics or TTY absence — is fragile. A user running `cambium run` from a shell script wrapped by systemd looks identical to cron. Magic detection breaks in edge cases.

Explicit flag is unambiguous, passes cleanly through compile-to-artifact manifests, and composes with dev-ergonomics tools (`cambium run --fired-by schedule:...@<custom_ts>` for testing).

Default absent = interactive keeps backward compatibility absolute. Every existing gen runs as it did before.

---

## Rejected alternatives

- **Cambium scheduler daemon (`cambium serve`).** Rationale above. Deferred as a future compile target if forcing cases emerge.
- **Detect scheduled runs via env / parent-process heuristics.** Too fragile. Explicit `--fired-by` wins.
- **Sub-second scheduling (`every: 100ms`).** Not cron; that's a stream primitive. Out of scope; separate design if it ever lands.
- **Dynamic cron** — "run again in 5 minutes, adjusted by last output." Triggers + memory handle this composition. Out of scope for the cron primitive itself.
- **Distributed coordination.** Single-node by design. k8s / your cloud already does leader election if you need it.
- **Manifest auto-deployment** — e.g. `cambium compile --schedule-target=k8s-cronjob --apply`. Rejected for v1: `kubectl apply` is the operator's tool, not Cambium's. Output YAML; let them deploy.
- **Full crontab expressiveness in named vocabulary.** "What does `:market_hours` mean on Canadian holidays?" Framework shouldn't own edge cases; named vocabulary is for universal cases only.

---

## Open questions (defer to impl ticket)

1. **Platform auth in compile output.** `k8s-cronjob` target needs a container image name. Pass as a `--image` flag? Read from `Genfile.toml [package].image`? Require at compile time? Similar question for `github-actions` (which secrets? which runner?). Lean: document conventions, require explicit config, fail the compile with a clear error if missing.
2. **Overlap detection for long-running scheduled gens.** If `:hourly` fires at 10:00 and the run takes 65 minutes, the 11:00 fire starts before 10:00 finishes. Framework behavior: `fire_id` is unique so memory writes don't clobber, but duplicate Slack notifications etc. are a concern. Document the pattern, defer enforcement.
3. **Named-vocabulary localization.** `cron :daily, at: "9:00"` — UTC? Server TZ? Explicit `tz:` kwarg? Lean: require explicit tz for non-UTC (`cron :daily, at: "9:00", tz: "America/New_York"`).
4. **Schedule metadata in compiled IR.** Carry the cron expression in the IR alongside the id? Pro: `cambium schedule preview` can compute fire times without re-parsing gen files. Con: changes to `cron :daily, at: "9:15"` force IR recompile to stay in sync. Lean: yes, include expression; it's what drives compile-to-artifact anyway.

All four are mechanical once the impl ticket picks them up.

---

## Implementation sketch

Filed as a separate impl ticket after this note merges. Shape:

### Ruby DSL (`ruby/cambium/runtime.rb`)

New `cron` method on GenModel + new `Cambium::Cron` module for crontab parsing and ID generation:

```ruby
def cron(expr_or_symbol, at: nil, tz: nil, method: nil, id: nil, **extra)
  # validation + ID generation
  # append to _cambium_defaults[:schedules]
end
```

### IR shape (`ruby/cambium/compile.rb`)

New `policies.schedules: Array<ScheduleDecl>`:

```json
{
  "policies": {
    "schedules": [
      {
        "id": "morning_digest.analyze.daily",
        "expression": "0 9 * * *",
        "named": "daily",
        "method": "analyze",
        "tz": "UTC"
      }
    ]
  }
}
```

### Runner (`packages/cambium-runner/src/runner.ts`)

- Parse `--fired-by` flag + `CAMBIUM_FIRED_BY` env var into `firedBy: { scheduleId, timestamp } | null`.
- Validate scheduleId against `ir.policies.schedules[]`; unknown ID → hard error.
- Compute `fire_id` and thread through to:
  - `trace.fired_by` field.
  - `ctx.fire_id` passed to action handlers via `ToolContext`.
  - `ddtags` in the log event (piggybacks on RED-302's existing tag-building).
- Compile-time validation: a gen with `memory scope: :schedule` but no `cron` declarations → compile error. (Done in Ruby, not runner.)
- Runtime validation: a run with `memory scope: :schedule` but no `--fired-by` → startup error.

### Memory (`packages/cambium-runner/src/memory/*`)

New `:schedule` scope resolver. `runs/memory/schedule/<schedule_id>/<memory_name>.sqlite`. Parallel to `:session` / `:global` / `:pool_name`.

### Compile targets (`cli/compile.mjs` or new `cli/schedule-targets/`)

Five target files, one per supported platform. Each takes the IR + user config, emits the manifest:

```ts
// cli/schedule-targets/k8s-cronjob.mjs
export function compile(ir, config) {
  // ... generate CronJob YAML per schedule ...
}
```

### CLI

- `cambium schedule compile <workspace> --target <target> [--out-dir <dir>] [--image <img>]` — emit manifests.
- `cambium schedule preview <gen.cmb.rb>` — print next N fires.
- `cambium schedule list` — workspace-wide schedule listing.

### Docs

- `docs/GenDSL Docs/P - cron (schedule).md` — primitive doc.
- `docs/GenDSL Docs/C - Trace (observability).md` — `fired_by` field.
- `docs/GenDSL Docs/C - IR (Intermediate Representation).md` — `policies.schedules` row.
- `CLAUDE.md` — Key concepts bullet + Pipeline-structure invariants.
- Deployment guides per target under `docs/deploy/`.

### Tests

- Compile-time: cron parse + IR shape + memory-schedule pairing validation.
- Runtime: `--fired-by` flag parsing, fire_id generation, memory scope routing, ddtags integration, interactive-rejection for schedule-scoped memory.
- Compile-to-artifact: golden-file tests per target (YAML diffing).
- E2E: tmpdir workspace with a cron'd gen → `cambium compile --schedule-target=k8s-cronjob` → generated YAML matches expected.

### Lift estimate

~6–8 hours focused work, similar shape to RED-302 (log primitive). Larger than a typical primitive because of the five compile targets, but each target is formulaic.

---

## Out of scope

- **Daemon / `cambium serve`.** Deferred as a future compile target.
- **Sub-second scheduling / streams.** Different primitive, separate design.
- **Dynamic cron.** Triggers + memory compose to handle this.
- **Distributed coordination.** Single-node; k8s provides leader election if needed.
- **Manifest auto-deployment.** `kubectl apply` / `crontab -` is the operator's tool.
- **Vocabulary beyond the v1 set.** Ship `:daily`/`:hourly`/`:weekly`/`:weekdays`/`:every_minute`; extend on real requests.

---

## See also

- [[N - App Mode vs Engine Mode (RED-220)]] — compile-to-artifact fits the engine-mode composability story
- [[P - Memory]] — `scope: :schedule` extends this
- [[P - log]] — `fired_by:schedule` ddtag integrates with the log primitive
- [[C - Trace (observability)]] — where `fired_by` lands
- RED-241 — prior-run state accessors (explicit companion)
- RED-214 — policy packs (compile-time declaration + runtime semantics precedent)
- RED-282 / RED-302 — log primitive (same shape: framework owns semantics, operator owns lifecycle)
- RED-212 — triggers (`ctx.fire_id` flows through action dispatch)
