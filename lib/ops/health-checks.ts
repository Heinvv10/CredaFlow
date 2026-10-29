import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { deleteManagedFileStrict, readFile, saveFileToManagedPath, storageEncryptionEnabled } from "@/lib/storage"
import { cronFreshness, type CronJobFreshness } from "@/lib/ops/cron-heartbeat"
import { cronSchedulerEnabled } from "@/lib/ops/cron-scheduler-flag"

/**
 * The checks behind /api/health. Database and storage decide the HTTP status
 * (deploy.sh and the compose healthcheck read it); cron freshness and storage
 * encryption are reported as warnings only, so a stack that was down overnight
 * still passes the health gate of the deploy that brings it back.
 */

export type CheckState = "ok" | "error"

export async function probeDatabase(): Promise<{ state: CheckState; latencyMs: number }> {
  const started = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    return { state: "ok", latencyMs: Date.now() - started }
  } catch (error) {
    console.error("[health] database check failed", error)
    return { state: "error", latencyMs: Date.now() - started }
  }
}

/**
 * Write, read back and delete a small file through lib/storage (so through
 * encryption when it is on): a full volume, a read-only mount or a wrong
 * encryption key all show here rather than on the next customer upload.
 */
export async function probeStorage(): Promise<CheckState> {
  const probe = Buffer.from(`health ${randomUUID()}`)
  let storagePath: string | null = null
  try {
    storagePath = (await saveFileToManagedPath(probe, "application/octet-stream", `healthprobe_${randomUUID().replace(/-/g, "")}`)).storagePath
    const back = await readFile(storagePath)
    return back.equals(probe) ? "ok" : "error"
  } catch (error) {
    console.error("[health] storage check failed", error)
    return "error"
  } finally {
    if (storagePath) {
      await deleteManagedFileStrict(storagePath).catch((error: unknown) => {
        console.error("[health] storage probe file not deleted", storagePath, error)
      })
    }
  }
}

export type CronState = "ok" | "stale" | "not_scheduled" | "error"

/** Only the staff container runs the scheduler (instrumentation.ts), and only with CRON_SECRET set and CRON_SCHEDULER not off. */
export async function probeCron(): Promise<{ state: CronState; jobs: CronJobFreshness[] }> {
  if (process.env.APP_MODE === "client" || !process.env.CRON_SECRET || !cronSchedulerEnabled(process.env)) return { state: "not_scheduled", jobs: [] }
  try {
    const jobs = await cronFreshness()
    return { state: jobs.some((j) => j.stale) ? "stale" : "ok", jobs }
  } catch (error) {
    console.error("[health] cron check failed", error)
    return { state: "error", jobs: [] }
  }
}

/**
 * Webhook events the outbox triggers could not write in the last 24 hours
 * (WebhookOutboxFailure): the payment, loan or application was saved, the
 * event was lost. Null when it could not be counted.
 */
export async function recentOutboxFailures(now: Date = new Date()): Promise<number | null> {
  try {
    return await prisma.webhookOutboxFailure.count({ where: { createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } })
  } catch (error) {
    console.error("[health] webhook outbox failure count failed", error)
    return null
  }
}

export function encryptionState(): "on" | "off" {
  return storageEncryptionEnabled() ? "on" : "off"
}
