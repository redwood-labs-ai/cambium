# Primitive: cron (schedule)

**Doc ID:** gen-dsl/primitive/cron

## Purpose

Declare that a gen runs on a recurring schedule. The framework owns the declaration, the IR representation, and the runtime semantics (memory scope, fire_id, observability tagging) of scheduled runs. The framework does NOT own the lifecycle — the operator's existing scheduler (crontab, k8s CronJob, Render cron, systemd, GH Actions) fires `cambium run ... --fired-by schedule:<id>` at the declared cadence.

Design note: [[N - Scheduled Gens (RED-273)]].

## Semantics (normative)

- A `cron` declaration produces one entry in `policies.schedules[]` on the IR.
- Schedule IDs are `<snake_gen>.<method>.<slug>`, auto-generated; stable across compiles.
- A gen may declare multiple `cron` directives; each must resolve to a unique ID.
- Runs invoked with `--fired-by schedule:<id>` are scheduled fires; the runner validates the id against the IR and refuses unknown ids.
- Runs without `--fired-by` are interactive; `trace.fired_by` is absent.
- `memory :x, scope: :schedule` requires at least one `cron` on the same gen (compile error otherwise) and requires `--fired-by` at runtime (startup error otherwise).

## Forms

### Named vocabulary

```ruby
cron :daily, at: "9:00"        # daily at 09:00
cron :weekly, at: "8:00"       # Sunday at 08:00
cron :weekdays, at: "9:00"     # Mon-Fri at 09:00
cron :hourly                   # top of every hour
cron :every_minute             # for testing
```

### Raw crontab

```ruby
cron "30 14 * * 1-5"           # 2:30pm weekdays
cron "0 9 1 * *"               # 9am on the 1st of every month
```

### Kwargs

| kwarg | purpose | default |
| --- | --- | --- |
| `at:` | HH:MM anchor for daily/weekly/weekdays | "0:00" (daily/weekly), "9:00" (weekdays) |
| `tz:` | time zone (`"America/New_York"` etc.) | "UTC" |
| `method:` | which method the cron fires | single user-defined method; required if multiple exist |
| `id:` | explicit slug override (matches `/^[a-z][a-z0-9_]*$/`) | named vocab token or hash of the crontab |

### Multi-schedule gens

```ruby
class Digest < Cambium::GenModel
  cron :daily, at: "9:00",  method: :morning
  cron :daily, at: "18:00", method: :evening

  def morning(input); end
  def evening(input); end
end
```

## Runtime: `--fired-by`

Operator's scheduler invokes the CLI with a declaration of intent:

```bash
cambium run app/gens/morning.cmb.rb \
  --method analyze \
  --fired-by schedule:morning_digest.analyze.daily@2026-04-22T09:00:00Z
```

Env-var equivalent: `CAMBIUM_FIRED_BY=schedule:<id>@<ts>` (crontab-friendly).

Timestamp is optional; when omitted, the runner stamps `Date.now()`.

## Semantic unlocks when `--fired-by` is set

- **Memory scope `:schedule`**: bucket path = `runs/memory/schedule/<schedule_id>/<name>.sqlite`. Per-schedule identity; different schedules never collide.
- **`trace.fired_by`**: set to the full `--fired-by` value.
- **RED-302 log events**: `fired_by: "schedule"` field + `fired_by:schedule` ddtag. DD filter `@fired_by:schedule AND @ok:false` surfaces every scheduled failure across all gens.
- **Action handlers**: receive a fire_id on `ctx.fire_id` (framework provides; action author uses as idempotency key against external systems).

## Compile-to-artifact

Cambium doesn't run the scheduler; it emits manifests for your platform's scheduler:

```bash
cambium schedule compile app/gens --target k8s-cronjob --image myregistry/cambium:v1
cambium schedule compile app/gens --target crontab > /etc/cron.d/cambium
cambium schedule compile app/gens --target systemd --out-dir ~/.config/systemd/user/
cambium schedule compile app/gens --target github-actions --out-dir .github/workflows/
cambium schedule compile app/gens --target render-cron
```

v1 targets: `k8s-cronjob`, `crontab`, `systemd`, `github-actions`, `render-cron`. Each emits a deploy-ready manifest that invokes `cambium run` with the right `--fired-by`.

## Dev ergonomics (static — no daemon)

- `cambium schedule preview <gen.cmb.rb> [--count N]` — print the next N fires for each declared schedule.
- `cambium schedule list [<dir>]` — walk a directory, list every schedule declared with its expression and next fire.

## Named-vocabulary expressions

| Named vocab | At | Produced crontab |
| --- | --- | --- |
| `:daily` | `"9:00"` | `0 9 * * *` |
| `:daily` | (default) | `0 0 * * *` |
| `:hourly` | — | `0 * * * *` |
| `:weekly` | `"8:00"` | `0 8 * * 0` (Sun) |
| `:weekdays` | `"9:00"` | `0 9 * * 1-5` |
| `:every_minute` | — | `* * * * *` |

## Example: scheduled digest with prior-run context

```ruby
class MorningDigest < Cambium::GenModel
  model "omlx:Qwen3.5-27B-4bit"
  system :morning_digest
  returns DigestReport

  cron :daily, at: "9:00"
  memory :yesterday, scope: :schedule, strategy: :sliding_window, size: 1
  write_memory_via :DigestMemoryAgent
  log :app_default

  def analyze(input)
    generate "today's digest, noting continuity from yesterday's" do
      with context: input
      returns DigestReport
    end
  end
end
```

A retro agent (`DigestMemoryAgent`) writes the previous run's signals to the `:yesterday` memory slot; the next daily fire reads it as part of its `## Memory` prompt block. See [[N - Prior-Run State Accessors (RED-241)]] for the pattern.

## See also

- [[N - Scheduled Gens (RED-273)]] — design rationale
- [[N - Prior-Run State Accessors (RED-241)]] — scope `:schedule` is the bucket identity that makes prior-run-read-back work
- [[P - Memory]] — `scope: :schedule` extends the scope enum
- [[P - log]] — `fired_by:schedule` ddtag integration
- [[C - IR (Intermediate Representation)]] — `policies.schedules` row
- [[C - Trace (observability)]] — `trace.fired_by` field
