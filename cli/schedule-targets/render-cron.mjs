// ── Render cron target (RED-305) ─────────────────────────────────────
//
// Emits a Render `render.yaml` cron-job snippet. Operator drops the
// snippet into their existing render.yaml's `services:` list.
//
// Render supports TZ via `schedule.timezone` in the yaml. Worth setting
// when the gen declared a non-UTC tz.

export function compileRenderCron(schedule, gen, config) {
  const name = schedule.id.replace(/\./g, '-');
  const env = config.envVars ?? {};
  const envBlock = Object.entries({
    CAMBIUM_FIRED_BY: `schedule:${schedule.id}`,
    ...env,
  })
    .map(([k, v]) => `      - key: ${k}\n        value: "${v}"`)
    .join('\n');

  return `  # ${schedule.id}
  - type: cron
    name: ${name}
    runtime: node
    region: ${config.region ?? 'oregon'}
    plan: ${config.plan ?? 'starter'}
    schedule: "${schedule.expression}"
    buildCommand: ${config.buildCommand ?? 'npm ci'}
    startCommand: cambium run ${gen.sourcePath} --method ${schedule.method}
    envVars:
${envBlock}
`;
}
