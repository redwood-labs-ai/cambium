// ── GitHub Actions target (RED-305) ──────────────────────────────────
//
// Emits a .github/workflows/<slug>.yml with `on: schedule:`. Operator
// commits it; GH runs the workflow on schedule.
//
// GH requires cron expressions in UTC — it ignores any TZ declaration.
// If the schedule declared a non-UTC tz, emit a comment warning; the
// cron expression itself remains the UTC-equivalent the operator wrote
// (or should have; Cambium doesn't currently convert UTC ↔ local at
// compile time — that's the operator's concern).

export function compileGithubActions(schedule, gen, config) {
  const name = schedule.id.replace(/\./g, '-');
  const image = config.image ?? 'ubuntu-latest';
  const tzComment = schedule.tz && schedule.tz !== 'UTC'
    ? `# NOTE: schedule declared tz ${schedule.tz}, but GH Actions always runs cron in UTC.\n` +
      `# Adjust the cron expression to the UTC equivalent before committing.\n`
    : '';

  return `${tzComment}name: ${schedule.id}

on:
  schedule:
    - cron: "${schedule.expression}"
  workflow_dispatch: {}

jobs:
  run:
    runs-on: ${image}
    steps:
      - uses: actions/checkout@v4
      - name: Run Cambium gen
        env:
          CAMBIUM_FIRED_BY: schedule:${schedule.id}
        run: |
          cambium run ${gen.sourcePath} --method ${schedule.method}
`;
}
