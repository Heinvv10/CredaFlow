import { logger } from "@/lib/observability/logger"
import { prisma } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"

/** An open row is left to its own after-response task for this long before the sweep takes it. */
export const DIGITAL_SWEEP_AFTER_MINUTES = 3
/** A claim older than this is a worker that died: the row is taken again. */
export const DIGITAL_CLAIM_STALE_MINUTES = 10
export const DIGITAL_MAX_ATTEMPTS = 5
/** Finished rows only feed the daily limits; they are pruned after this long. */
export const DIGITAL_DUE_RETENTION_DAYS = 30
/**
 * Automatic bureau pulls are paid for, and anyone can submit an application: past
 * these in 24 hours the application stays with staff, with no pull. Per client and per
 * submitting address (a client limit alone is walked around with new accounts). A caller
 * whose address is not known (no trusted proxy) shares ONE bucket per lender, so not
 * knowing the address is never a way round the limit.
 */
export const DIGITAL_REVIEWS_PER_CLIENT_PER_DAY = 3
export const DIGITAL_REVIEWS_PER_IP_PER_DAY = 10
export const DIGITAL_REVIEWS_UNKNOWN_IP_PER_DAY = 10
const SWEEP_BATCH = 50

const minutes = (n: number) => n * 60_000

/**
 * Records, before the after-response task is scheduled, that a digitally submitted
 * application is due its automatic review; the task (or, if it is lost, the sweep)
 * completes it. Only for a lender whose engine is on and covers the portal. True
 * when a row exists (this call's or an earlier one's).
 */
export async function markDigitalDecisionDue(input: { tenantId: string; applicationId: string; clientId?: string; ip: string | null }): Promise<boolean> {
  const config = await prisma.decisionEngineConfig.findUnique({ where: { tenantId: input.tenantId }, select: { mode: true, channels: true } })
  if (!config || config.mode === "OFF" || !config.channels.includes("PORTAL")) return false
  // A route that does not hold the client's id (the website form) leaves it to the application.
  const clientId = input.clientId ?? (await prisma.loanApplication.findFirst({ where: { id: input.applicationId, tenantId: input.tenantId }, select: { clientId: true } }))?.clientId
  if (!clientId) return false
  try {
    await prisma.autoDecisionDue.create({ data: { tenantId: input.tenantId, applicationId: input.applicationId, clientId, ip: input.ip } })
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
  }
  return true
}

async function complete(tenantId: string, applicationId: string, outcome: string, now: Date): Promise<void> {
  await prisma.autoDecisionDue.updateMany({ where: { tenantId, applicationId, completedAt: null }, data: { completedAt: now, outcome } })
}

/**
 * Admits one review against the daily limits, or refuses it. The count and the charge are one
 * step under advisory locks (per client, per address bucket; always taken in the same order),
 * so concurrent submissions cannot all read "below the limit" and all pass. A review is charged
 * (`chargedAt`) the moment it is admitted, before its paid pull, so one still running counts.
 * A row already charged (a retry after a crash) is admitted without a second charge.
 */
export async function admitDigitalReview(row: { id: string; tenantId: string; clientId: string; ip: string | null; chargedAt: Date | null }, now: Date): Promise<boolean> {
  if (row.chargedAt) return true
  const since = new Date(now.getTime() - minutes(24 * 60))
  const locks = [`digital-due:client:${row.tenantId}:${row.clientId}`, `digital-due:ip:${row.tenantId}:${row.ip ?? "unknown"}`].sort()
  return prisma.$transaction(async (tx) => {
    for (const key of locks) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
    const charged = { tenantId: row.tenantId, chargedAt: { gte: since } }
    if ((await tx.autoDecisionDue.count({ where: { ...charged, clientId: row.clientId } })) >= DIGITAL_REVIEWS_PER_CLIENT_PER_DAY) return false
    const addressLimit = row.ip === null ? DIGITAL_REVIEWS_UNKNOWN_IP_PER_DAY : DIGITAL_REVIEWS_PER_IP_PER_DAY
    if ((await tx.autoDecisionDue.count({ where: { ...charged, ip: row.ip } })) >= addressLimit) return false
    await tx.autoDecisionDue.update({ where: { id: row.id }, data: { chargedAt: now } })
    return true
  })
}

/**
 * Claims one due row and runs its review. Nothing is run for a row someone else
 * holds or that is complete. An error leaves the row open (claimed), so the sweep
 * retakes it once the claim goes stale.
 */
export async function runDigitalDue(input: { tenantId: string; applicationId: string; now?: Date }): Promise<void> {
  return runWithTenant(input.tenantId, () => runClaimedDue(input))
}

async function runClaimedDue(input: { tenantId: string; applicationId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date()
  const claimed = await prisma.autoDecisionDue.updateMany({
    where: {
      tenantId: input.tenantId, applicationId: input.applicationId, completedAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - minutes(DIGITAL_CLAIM_STALE_MINUTES)) } }],
    },
    data: { claimedAt: now, attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) return
  const row = await prisma.autoDecisionDue.findFirst({ where: { tenantId: input.tenantId, applicationId: input.applicationId }, select: { id: true, tenantId: true, clientId: true, ip: true, chargedAt: true } })
  if (!row) return
  try {
    if (!(await admitDigitalReview(row, now))) return await complete(input.tenantId, input.applicationId, "RATE_LIMITED", now)
    const { reviewDigitalSubmission } = await import("./digital-submission")
    const result = await reviewDigitalSubmission({ tenantId: input.tenantId, applicationId: input.applicationId })
    await complete(input.tenantId, input.applicationId, result.status === "SKIPPED" ? result.reason : result.status === "REVIEW_REFUSED" ? `REVIEW_REFUSED_${result.httpStatus}` : result.status, now)
  } catch (error) {
    logger.error("auto-decision: digital review failed; the sweep will retry", { applicationId: input.applicationId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** The cron's work: every open row older than the grace period that nobody holds, across lenders. */
export async function sweepDigitalDecisions(input: { now?: Date } = {}): Promise<{ swept: number; gaveUp: number; failed: number; pruned: number }> {
  const now = input.now ?? new Date()
  const pruned = await withoutTenantScope(async () => await prisma.autoDecisionDue.deleteMany({ where: { completedAt: { lt: new Date(now.getTime() - minutes(DIGITAL_DUE_RETENTION_DAYS * 24 * 60)) } } }))
  // Awaited inside the frame: a Prisma query is lazy and would otherwise run after the frame has closed.
  const rows = await withoutTenantScope(async () => await prisma.autoDecisionDue.findMany({
    where: {
      completedAt: null,
      createdAt: { lt: new Date(now.getTime() - minutes(DIGITAL_SWEEP_AFTER_MINUTES)) },
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - minutes(DIGITAL_CLAIM_STALE_MINUTES)) } }],
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  }))
  const result = { swept: 0, gaveUp: 0, failed: 0, pruned: pruned.count }
  for (const row of rows) {
    if (row.attempts >= DIGITAL_MAX_ATTEMPTS) {
      await runWithTenant(row.tenantId, () => complete(row.tenantId, row.applicationId, "GAVE_UP", now))
      result.gaveUp += 1
      continue
    }
    try {
      await runWithTenant(row.tenantId, () => runDigitalDue({ tenantId: row.tenantId, applicationId: row.applicationId, now }))
      result.swept += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
