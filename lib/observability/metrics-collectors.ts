import { prisma } from "@/lib/prisma"
import { CRON_FRESHNESS_MINUTES } from "@/lib/ops/cron-heartbeat"
import { probeDatabase, recentOutboxFailures } from "@/lib/ops/health-checks"
import { logger } from "./logger"
import { getMetrics, newGauge } from "./metrics"

/**
 * Gauges read from the database at scrape time, so any replica reports the
 * same shared state (cron heartbeats are rows, not process memory). Attached
 * once, by the first scrape. A collector that throws is logged and skipped:
 * a half-answering database must not turn the scrape itself into a 500.
 */
export function attachDatabaseCollectors(): void {
  const metrics = getMetrics()
  if (metrics.collectorsAttached) return
  metrics.collectorsAttached = true

  newGauge("credaflow_database_up", "1 when SELECT 1 succeeds, else 0.", [], async (gauge) => {
    const database = await probeDatabase()
    gauge.set(database.state === "ok" ? 1 : 0)
  })

  newGauge("credaflow_webhook_outbox_failures_24h", "Webhook events the outbox triggers could not write in the last 24 hours.", [], async (gauge) => {
    const count = await recentOutboxFailures()
    if (count !== null) gauge.set(count)
  })

  newGauge("credaflow_cron_last_success_timestamp_seconds", "Unix time of each in-process cron job's last successful run. A job that never succeeded has no series.", ["job"], async (gauge) => {
    try {
      const rows = await prisma.cronHeartbeat.findMany({ select: { job: true, lastSucceededAt: true } })
      for (const row of rows) {
        if (row.lastSucceededAt) gauge.set({ job: row.job.replace("/api/cron/", "") }, Math.floor(row.lastSucceededAt.getTime() / 1000))
      }
    } catch (error) {
      logger.warn("[metrics] cron heartbeats not read", { error: String(error) })
    }
  })

  newGauge("credaflow_cron_freshness_budget_seconds", "How long each in-process cron job may go without a success before /api/health calls it stale.", ["job"], async (gauge) => {
    for (const [job, minutes] of Object.entries(CRON_FRESHNESS_MINUTES)) gauge.set({ job }, minutes * 60)
  })
}
