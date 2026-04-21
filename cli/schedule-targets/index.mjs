// ── Schedule-target dispatch (RED-273 / RED-305) ─────────────────────
//
// Operator picks a target; we emit the right manifest shape for it.
// Each target is a pure function: (schedule, gen, config) → text.
// Target is tangled only with what this particular scheduler wants;
// the IR is already fully normalized upstream, so target code is
// small and formulaic.

import { compileK8sCronJob } from './k8s-cronjob.mjs';
import { compileCrontab } from './crontab.mjs';
import { compileSystemd } from './systemd.mjs';
import { compileGithubActions } from './github-actions.mjs';
import { compileRenderCron } from './render-cron.mjs';

const TARGETS = {
  'k8s-cronjob':    compileK8sCronJob,
  'crontab':        compileCrontab,
  'systemd':        compileSystemd,
  'github-actions': compileGithubActions,
  'render-cron':    compileRenderCron,
};

export function availableTargets() {
  return Object.keys(TARGETS);
}

export function compileScheduleTarget(target, schedule, gen, config) {
  const fn = TARGETS[target];
  if (!fn) {
    throw new Error(
      `Unknown --schedule-target "${target}". Available: ${availableTargets().join(', ')}.`,
    );
  }
  return fn(schedule, gen, config);
}
