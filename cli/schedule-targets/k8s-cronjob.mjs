// ── k8s CronJob target (RED-305) ─────────────────────────────────────
//
// Emits one CronJob manifest per declared schedule. Operator deploys
// with `kubectl apply -f <gen>-<slug>.cronjob.yaml`.
//
// The generated manifest invokes `cambium run <gen-file> --method <m>
// --fired-by schedule:<id>@<timestamp>` inside the user-configured
// container image.
//
// K8s-specific: `.spec.jobTemplate.spec.template.spec.restartPolicy`
// must be OnFailure or Never (not Always) for CronJobs — we pick
// OnFailure to let k8s re-run transient failures once.

export function compileK8sCronJob(schedule, gen, config) {
  if (!config.image) {
    throw new Error(
      `--schedule-target=k8s-cronjob requires --image <container-image>. ` +
      `Pass --image <registry/repo:tag> on the compile invocation.`,
    );
  }

  const name = schedule.id.replace(/\./g, '-');
  const suspend = config.suspend ? 'true' : 'false';

  return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${name}
  labels:
    cambium.schedule/id: ${schedule.id}
    cambium.schedule/gen: ${gen.snakeClass}
    cambium.schedule/method: ${schedule.method}
spec:
  schedule: "${schedule.expression}"
  timeZone: "${schedule.tz ?? 'UTC'}"
  concurrencyPolicy: Forbid
  suspend: ${suspend}
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: cambium
            image: ${config.image}
            command:
              - cambium
              - run
              - ${gen.sourcePath}
              - --method
              - ${schedule.method}
              - --fired-by
              - schedule:${schedule.id}
`;
}
