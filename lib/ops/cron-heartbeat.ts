import { prisma } from "@/lib/prisma"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"

/**
 * One row per in-process cron job (instrumentation.ts callCron), written after
 * each run; /api/health reads it to report jobs that have stopped running.
 * Jobs an external scheduler owns are not recorded here.
 */
export async function recordCronRun(job: string, run: { startedAt: Date; status: number | null; error: string | null }): Promise<void> {
  const finishedAt = new Date()
  const ok = run.status !== null && run.status >= 200 && run.status < 300
  const fields = {
    lastStartedAt: run.startedAt,
    lastFinishedAt: finishedAt,
    lastStatus: run.status,
    lastError: run.error?.slice(0, 500) ?? null,
    ...(ok ? { lastSucceededAt: finishedAt } : {}),
  }
  await prisma.cronHeartbeat.upsert({ where: { job }, create: { job, ...fields }, update: fields })
}

/**
 * How long each in-process job may go without a successful run before
 * /api/health calls it stale: each job's `freshnessMinutes` in
 * lib/registry/cron-jobs/, the same entry instrumentation.ts schedules from.
 */
export const CRON_FRESHNESS_MINUTES: Record<string, number> = Object.fromEntries(
  CRON_JOBS.flatMap((job) => (job.owner === "in-process" ? [[job.route, job.freshnessMinutes]] : [])),
)

export interface CronJobFreshness {
  job: string
  lastSucceededAt: string | null
  lastStatus: number | null
  stale: boolean
}

/**
 * Stale: no success within the job's budget, counted only once this process
 * has been up longer than the budget (a fresh boot has not had the chance).
 */
export async function cronFreshness(now: Date = new Date(), uptimeSeconds: number = process.uptime()): Promise<CronJobFreshness[]> {
  const rows = await prisma.cronHeartbeat.findMany({ select: { job: true, lastSucceededAt: true, lastStatus: true } })
  const byJob = new Map(rows.map((r) => [r.job, r]))
  return Object.entries(CRON_FRESHNESS_MINUTES).map(([job, minutes]) => {
    const row = byJob.get(`/api/cron/${job}`)
    const budgetMs = minutes * 60_000
    const last = row?.lastSucceededAt ?? null
    const overdue = !last || now.getTime() - last.getTime() > budgetMs
    return {
      job,
      lastSucceededAt: last?.toISOString() ?? null,
      lastStatus: row?.lastStatus ?? null,
      stale: overdue && uptimeSeconds * 1000 > budgetMs,
    }
  })
}
