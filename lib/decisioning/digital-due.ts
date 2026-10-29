import { isIP } from "node:net"
import { logger } from "@/lib/observability/logger"
import { prisma } from "@/lib/prisma"
import type { Tx } from "@/lib/maker-checker/types"
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
/**
 * Ceiling on automatic paid pulls per lender per day whoever submits them (a botnet has many
 * addresses and clients). Operations raise or lower it with DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY.
 */
export const DIGITAL_REVIEWS_PER_LENDER_PER_DAY_DEFAULT = 200
const SWEEP_BATCH = 50

export function digitalReviewsPerLenderPerDay(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY)
  return Number.isInteger(configured) && configured > 0 ? configured : DIGITAL_REVIEWS_PER_LENDER_PER_DAY_DEFAULT
}

/**
 * The bucket a submitting address counts in: an IPv6 address by its /64 (one subscriber holds a whole
 * /64, so counting single addresses is no limit at all), a zone id stripped, an IPv4-mapped IPv6 address
 * as its IPv4. Anything that is not an address, or is too long to store, is the unknown bucket (null).
 */
export function ipBucket(ip: string | null | undefined): string | null {
  if (!ip) return null
  const bare = ip.trim().split("%")[0]
  if (bare.length === 0 || bare.length > 45) return null
  const family = isIP(bare)
  if (family === 4) return bare
  if (family !== 6) return null
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)
  if (mapped && isIP(mapped[1]) === 4) return mapped[1]
  const [head, tail = ""] = bare.toLowerCase().split("::")
  const headGroups = head === "" ? [] : head.split(":")
  const tailGroups = tail === "" ? [] : tail.split(":")
  const groups = bare.includes("::") ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups] : headGroups
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`
}

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
    await prisma.autoDecisionDue.create({ data: { tenantId: input.tenantId, applicationId: input.applicationId, clientId, ip: ipBucket(input.ip) } })
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
  }
  return true
}

async function complete(tenantId: string, applicationId: string, outcome: string, now: Date): Promise<void> {
  await prisma.autoDecisionDue.updateMany({ where: { tenantId, applicationId, completedAt: null }, data: { completedAt: now, outcome } })
}

type AdmitDb = Pick<Tx, "autoDecisionDue" | "$executeRaw">

/**
 * Admits one automatic review against the daily limits, or refuses it. Called by the review once its
 * KYC and document gates have passed and before the paid pull (so a refusal costs nothing and a
 * client the gates stop never uses a slot), in the transaction that claims the application. The count and
 * the charge are one step under advisory locks (per client, per address bucket, per lender; always taken
 * in the same order), so concurrent submissions cannot all read "below the limit" and all pass. A review is
 * charged (`chargedAt`) when admitted, so one still running counts. A row already charged (a retry after a
 * crash) is admitted without a second charge. `ip` is the bucket (ipBucket); null is the shared unknown bucket.
 */
export async function admitDigitalReview(
  tx: AdmitDb,
  row: { id: string; tenantId: string; clientId: string; ip: string | null; chargedAt: Date | null },
  now: Date,
  lenderCeiling: number = digitalReviewsPerLenderPerDay(),
): Promise<boolean> {
  if (row.chargedAt) return true
  const since = new Date(now.getTime() - minutes(24 * 60))
  const locks = [`digital-due:client:${row.tenantId}:${row.clientId}`, `digital-due:ip:${row.tenantId}:${row.ip ?? "unknown"}`, `digital-due:lender:${row.tenantId}`].sort()
  for (const key of locks) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
  const charged = { tenantId: row.tenantId, chargedAt: { gte: since } }
  if ((await tx.autoDecisionDue.count({ where: charged })) >= lenderCeiling) return false
  if ((await tx.autoDecisionDue.count({ where: { ...charged, clientId: row.clientId } })) >= DIGITAL_REVIEWS_PER_CLIENT_PER_DAY) return false
  const addressLimit = row.ip === null ? DIGITAL_REVIEWS_UNKNOWN_IP_PER_DAY : DIGITAL_REVIEWS_PER_IP_PER_DAY
  if ((await tx.autoDecisionDue.count({ where: { ...charged, ip: row.ip } })) >= addressLimit) return false
  await tx.autoDecisionDue.update({ where: { id: row.id }, data: { chargedAt: now } })
  return true
}

/** What one attempt did: it finished the row, left it for a retry (an error), or found nothing to do. */
export type DigitalDueRun = "COMPLETED" | "FAILED" | "NOT_CLAIMED"

/**
 * Claims one due row and runs its review. Nothing is run for a row someone else
 * holds or that is complete. An error leaves the row open (claimed), so the sweep
 * retakes it once the claim goes stale.
 */
export async function runDigitalDue(input: { tenantId: string; applicationId: string; now?: Date }): Promise<DigitalDueRun> {
  return runWithTenant(input.tenantId, () => runClaimedDue(input))
}

async function runClaimedDue(input: { tenantId: string; applicationId: string; now?: Date }): Promise<DigitalDueRun> {
  const now = input.now ?? new Date()
  const claimed = await prisma.autoDecisionDue.updateMany({
    where: {
      tenantId: input.tenantId, applicationId: input.applicationId, completedAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - minutes(DIGITAL_CLAIM_STALE_MINUTES)) } }],
    },
    data: { claimedAt: now, attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) return "NOT_CLAIMED"
  const row = await prisma.autoDecisionDue.findFirst({ where: { tenantId: input.tenantId, applicationId: input.applicationId }, select: { id: true, tenantId: true, clientId: true, ip: true, chargedAt: true } })
  if (!row) return "NOT_CLAIMED"
  try {
    const { reviewDigitalSubmission } = await import("./digital-submission")
    // The limits are checked by the review itself, after its gates and before its paid pull.
    const result = await reviewDigitalSubmission({ tenantId: input.tenantId, applicationId: input.applicationId, admit: (tx) => admitDigitalReview(tx, row, now) })
    await complete(input.tenantId, input.applicationId, result.status === "SKIPPED" ? result.reason : result.status === "REVIEW_REFUSED" ? `REVIEW_REFUSED_${result.httpStatus}` : result.status, now)
    return "COMPLETED"
  } catch (error) {
    logger.error("auto-decision: digital review failed; the sweep will retry", { applicationId: input.applicationId, error: error instanceof Error ? error.message : String(error) })
    return "FAILED"
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
      const ran = await runWithTenant(row.tenantId, () => runDigitalDue({ tenantId: row.tenantId, applicationId: row.applicationId, now }))
      if (ran === "FAILED") result.failed += 1
      else result.swept += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
