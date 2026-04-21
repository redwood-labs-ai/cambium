/**
 * RED-305: golden-ish tests for each compile-to-artifact schedule target.
 *
 * We don't use real golden files (to avoid cross-platform line-ending
 * churn); instead we pin the invariants each target guarantees —
 * required fields, the correct crontab expression in the right slot,
 * CAMBIUM_FIRED_BY present, etc.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — mjs module imported from ts tests, no .d.ts.
import { compileScheduleTarget, availableTargets } from '../../../cli/schedule-targets/index.mjs';

const schedule = {
  id: 'morning_digest.analyze.daily',
  expression: '0 9 * * *',
  method: 'analyze',
  tz: 'UTC',
  named: 'daily',
  at: '9:00',
};
const gen = {
  className: 'MorningDigest',
  snakeClass: 'morning_digest',
  sourcePath: 'app/gens/morning_digest.cmb.rb',
  absolutePath: '/abs/app/gens/morning_digest.cmb.rb',
};

describe('schedule-target index', () => {
  it('lists all five v1 targets', () => {
    expect(new Set(availableTargets())).toEqual(
      new Set(['k8s-cronjob', 'crontab', 'systemd', 'github-actions', 'render-cron']),
    );
  });

  it('rejects unknown target with a clear error', () => {
    expect(() => compileScheduleTarget('fly-machines', schedule, gen, {})).toThrow(
      /Unknown --schedule-target/,
    );
  });
});

describe('k8s-cronjob target', () => {
  it('requires --image config', () => {
    expect(() => compileScheduleTarget('k8s-cronjob', schedule, gen, {})).toThrow(
      /requires --image/,
    );
  });

  it('emits a CronJob manifest with the right cron expression and command', () => {
    const yaml = compileScheduleTarget('k8s-cronjob', schedule, gen, {
      image: 'myregistry/cambium:latest',
    });
    expect(yaml).toMatch(/^apiVersion: batch\/v1$/m);
    expect(yaml).toMatch(/^kind: CronJob$/m);
    expect(yaml).toMatch(/schedule: "0 9 \* \* \*"/);
    expect(yaml).toMatch(/timeZone: "UTC"/);
    expect(yaml).toContain('cambium.schedule/id: morning_digest.analyze.daily');
    expect(yaml).toContain('image: myregistry/cambium:latest');
    expect(yaml).toContain('--fired-by');
    expect(yaml).toContain('schedule:morning_digest.analyze.daily');
    expect(yaml).toContain('concurrencyPolicy: Forbid');
  });
});

describe('crontab target', () => {
  it('emits a single crontab line with the cron expression', () => {
    const out = compileScheduleTarget('crontab', schedule, gen, {});
    expect(out).toMatch(/^0 9 \* \* \* CAMBIUM_FIRED_BY=schedule:morning_digest\.analyze\.daily cambium run/m);
    expect(out).toContain('--method analyze');
  });

  it('warns via comment when tz is non-UTC', () => {
    const nonUtc = { ...schedule, tz: 'America/New_York' };
    const out = compileScheduleTarget('crontab', nonUtc, gen, {});
    expect(out).toContain('# TZ: America/New_York');
  });

  it('supports a --binary override for non-path installs', () => {
    const out = compileScheduleTarget('crontab', schedule, gen, { binary: '/usr/local/bin/cambium' });
    expect(out).toContain('/usr/local/bin/cambium run');
  });
});

describe('systemd target', () => {
  it('emits both .service and .timer files', () => {
    const out = compileScheduleTarget('systemd', schedule, gen, {});
    expect(typeof out).toBe('object');
    const keys = Object.keys(out);
    expect(keys).toContain('morning_digest-analyze-daily.service');
    expect(keys).toContain('morning_digest-analyze-daily.timer');
  });

  it('.service carries CAMBIUM_FIRED_BY and the run command', () => {
    const out = compileScheduleTarget('systemd', schedule, gen, {}) as Record<string, string>;
    const svc = out['morning_digest-analyze-daily.service'];
    expect(svc).toContain('Environment=CAMBIUM_FIRED_BY=schedule:morning_digest.analyze.daily');
    expect(svc).toContain('ExecStart=cambium run app/gens/morning_digest.cmb.rb');
  });

  it('.timer translates daily-at-9 crontab to systemd OnCalendar', () => {
    const out = compileScheduleTarget('systemd', schedule, gen, {}) as Record<string, string>;
    const timer = out['morning_digest-analyze-daily.timer'];
    expect(timer).toMatch(/OnCalendar=\*-\*-\* 09:00:00/);
  });

  it('.timer falls back to hand-translate comment on untranslatable expression', () => {
    const unusual = { ...schedule, expression: '0 9 1 1 *' }; // Jan 1st 9am
    const out = compileScheduleTarget('systemd', unusual, gen, {}) as Record<string, string>;
    const timer = out['morning_digest-analyze-daily.timer'];
    expect(timer).toMatch(/could not auto-translate/);
  });
});

describe('github-actions target', () => {
  it('emits a workflow with on.schedule.cron and CAMBIUM_FIRED_BY env', () => {
    const out = compileScheduleTarget('github-actions', schedule, gen, {}) as string;
    expect(out).toMatch(/on:\s*\n\s*schedule:/);
    expect(out).toContain('- cron: "0 9 * * *"');
    expect(out).toContain('CAMBIUM_FIRED_BY: schedule:morning_digest.analyze.daily');
    expect(out).toContain('cambium run app/gens/morning_digest.cmb.rb --method analyze');
  });

  it('warns when tz is non-UTC (GH cron is UTC-only)', () => {
    const nonUtc = { ...schedule, tz: 'America/New_York' };
    const out = compileScheduleTarget('github-actions', nonUtc, gen, {}) as string;
    expect(out).toContain('GH Actions always runs cron in UTC');
  });
});

describe('render-cron target', () => {
  it('emits a Render cron service entry', () => {
    const out = compileScheduleTarget('render-cron', schedule, gen, {}) as string;
    expect(out).toContain('type: cron');
    expect(out).toContain('name: morning_digest-analyze-daily');
    expect(out).toContain('schedule: "0 9 * * *"');
    expect(out).toContain('key: CAMBIUM_FIRED_BY');
    expect(out).toContain('value: "schedule:morning_digest.analyze.daily"');
  });

  it('honors region and plan overrides', () => {
    const out = compileScheduleTarget('render-cron', schedule, gen, {
      region: 'frankfurt',
      plan: 'pro',
    }) as string;
    expect(out).toContain('region: frankfurt');
    expect(out).toContain('plan: pro');
  });
});
