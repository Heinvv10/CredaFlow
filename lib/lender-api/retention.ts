import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/**
 * Retention for the lender API's operational logs (the lender-api-retention
 * cron, nightly):
 *   - ApiRequestLog rows older than API_LOG_RETENTION_DAYS (default 90);
 *   - finished WebhookDelivery rows (SUCCEEDED, FAILED) older than
 *     WEBHOOK_LOG_RETENTION_DAYS (default 30), then dispatched WebhookEvent
 *     rows older than that with no delivery left, and WebhookOutboxFailure
 *     rows (lost events) older than that.
 * PENDING deliveries and their events are never pruned. Deleted in batches so
 * one run never holds a long lock. Raw SQL: these are cross-tenant sweeps.
 */

const BATCH = 5_000
const MAX_BATCHES = 200

export function retentionDays(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error(`${name} must be a whole number of days from 1 to 3650`)
  return n
}

async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run()
    total += n
    if (n < BATCH) break
  }
  return total
}

export interface RetentionResult {
  apiRequestLogs: number
  webhookDeliveries: number
  webhookEvents: number
  webhookOutboxFailures: number
  apiLogDays: number
  webhookDays: number
}

export async function pruneLenderApiLogs(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<RetentionResult> {
  const apiLogDays = retentionDays(env, "API_LOG_RETENTION_DAYS", 90)
  const webhookDays = retentionDays(env, "WEBHOOK_LOG_RETENTION_DAYS", 30)
  const apiCutoff = new Date(now.getTime() - apiLogDays * 86_400_000)
  const hookCutoff = new Date(now.getTime() - webhookDays * 86_400_000)

  const apiRequestLogs = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "ApiRequestLog" WHERE "id" IN (
      SELECT "id" FROM "ApiRequestLog" WHERE "createdAt" < ${apiCutoff} LIMIT ${BATCH})`))
  const webhookDeliveries = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "WebhookDelivery" WHERE "id" IN (
      SELECT "id" FROM "WebhookDelivery"
      WHERE "status" IN ('SUCCEEDED', 'FAILED') AND "createdAt" < ${hookCutoff} LIMIT ${BATCH})`))
  const webhookEvents = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "WebhookEvent" WHERE "id" IN (
      SELECT ev."id" FROM "WebhookEvent" ev
      WHERE ev."dispatchedAt" IS NOT NULL AND ev."createdAt" < ${hookCutoff}
        AND NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."eventId" = ev."id")
      LIMIT ${BATCH})`))
  const webhookOutboxFailures = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "WebhookOutboxFailure" WHERE "id" IN (
      SELECT "id" FROM "WebhookOutboxFailure" WHERE "createdAt" < ${hookCutoff} LIMIT ${BATCH})`))
  return { apiRequestLogs, webhookDeliveries, webhookEvents, webhookOutboxFailures, apiLogDays, webhookDays }
}
