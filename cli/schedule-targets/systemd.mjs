// ── systemd target (RED-305) ─────────────────────────────────────────
//
// Emits a paired .service + .timer unit. Operator drops under
// ~/.config/systemd/user/ (user scope) or /etc/systemd/system/ and
// `systemctl --user enable --now <timer>`.
//
// systemd's OnCalendar syntax is NOT identical to crontab. We emit
// the crontab expression in a comment and translate the common cases
// (daily/hourly/weekly/every_minute) to native OnCalendar. For raw
// crontab the operator may need to hand-translate to OnCalendar.

function crontabToOnCalendar(expr) {
  // Handle the common named-vocab outputs. Raw crontab with complex
  // fields gets passed through as a comment — systemd's OnCalendar
  // doesn't accept crontab syntax.
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*' && dow === '*') {
    if (min.match(/^\d+$/) && hour.match(/^\d+$/)) {
      return `*-*-* ${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00`;
    }
    if (min === '0' && hour === '*') return 'hourly';
    if (min === '*' && hour === '*') return '*:*:00';
  }
  if (dom === '*' && mon === '*' && dow === '0') {
    // Sunday
    return `Sun *-*-* ${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00`;
  }
  if (dom === '*' && mon === '*' && dow === '1-5') {
    return `Mon..Fri *-*-* ${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00`;
  }
  return null;
}

export function compileSystemd(schedule, gen, config) {
  const binary = config.binary ?? 'cambium';
  const name = schedule.id.replace(/\./g, '-');
  const onCalendar = crontabToOnCalendar(schedule.expression);
  const fallbackComment = onCalendar
    ? ''
    : `# NOTE: could not auto-translate "${schedule.expression}" to systemd OnCalendar.\n` +
      `# Replace the OnCalendar= line below with the equivalent systemd calendar expression.\n`;
  const calendarValue = onCalendar ?? `# ${schedule.expression} (hand-translate)`;

  const service = `[Unit]
Description=Cambium scheduled gen: ${schedule.id}

[Service]
Type=oneshot
Environment=CAMBIUM_FIRED_BY=schedule:${schedule.id}
ExecStart=${binary} run ${gen.sourcePath} --method ${schedule.method}
`;

  const timer = `[Unit]
Description=Timer for Cambium schedule: ${schedule.id}

[Timer]
${fallbackComment}OnCalendar=${calendarValue}
Persistent=true
Unit=${name}.service

[Install]
WantedBy=timers.target
`;

  return { [`${name}.service`]: service, [`${name}.timer`]: timer };
}
