const OFF_VALUES = new Set(["off", "false", "0"])

/**
 * Whether this process registers the in-process cron scheduler
 * (instrumentation.ts). On unless `CRON_SCHEDULER` is off, so a deploy that
 * sets nothing behaves as before. The Helm chart sets it off on the web
 * Deployment and leaves it on for the single-replica worker: only singleRun
 * jobs take a CronRunClaim, every other job fires on each replica that
 * schedules it.
 */
export function cronSchedulerEnabled(env: Partial<Record<string, string>>): boolean {
  return !OFF_VALUES.has((env.CRON_SCHEDULER ?? "").trim().toLowerCase())
}
