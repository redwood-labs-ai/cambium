// ── crontab target (RED-305) ─────────────────────────────────────────
//
// Emits one crontab line per schedule. Operator pipes to `crontab -` or
// drops into `/etc/cron.d/cambium`. Uses CAMBIUM_FIRED_BY env (more
// crontab-portable than a long --fired-by flag argument).

export function compileCrontab(schedule, gen, config) {
  const binary = config.binary ?? 'cambium';
  const genPath = config.absoluteGenPath
    ? gen.absolutePath
    : gen.sourcePath;
  const env = `CAMBIUM_FIRED_BY=schedule:${schedule.id}`;
  // Crontab TZ handling varies by implementation; emit a comment
  // declaring the intended TZ. Operators can add `TZ=...` at the top
  // of their crontab file if their cron respects it (most do).
  const tzComment = schedule.tz && schedule.tz !== 'UTC'
    ? `# TZ: ${schedule.tz} (add TZ=${schedule.tz} at top of crontab if your cron honors it)\n`
    : '';
  return `${tzComment}# ${schedule.id} (gen: ${gen.className}, method: ${schedule.method})\n` +
    `${schedule.expression} ${env} ${binary} run ${genPath} --method ${schedule.method}\n`;
}
