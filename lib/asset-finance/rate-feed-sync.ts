/**
 * Records the SARB feed's values as PENDING reference rates, for every tenant
 * with featureAssetFinance on (the sweep behind app/api/cron/reference-rate-feed).
 *
 * Four-eyes is unchanged: a fetched value is a ReferenceRate row with source
 * SARB_FEED and no requester, born PENDING, and a user with
 * decide_asset_finance approves or rejects it through the usual decide flow.
 * Nothing here approves anything, and nothing reprices on a PENDING value.
 *
 * Per tenant and basis, against the latest live (APPROVED or PENDING) value:
 *   - none yet: record it.
 *   - same value: nothing to record.
 *   - PRIME and REPO: any other value is recorded.
 *   - ZARONIA moves daily by basis points: recorded only from 25 bp away.
 *   - an observation dated before the latest live value is stale (a value
 *     pre-recorded for a coming date is not undone by the feed): skipped.
 *   - a PENDING feed row with the same value already waits: skipped.
 * The observation date is the row's effectiveDate. A concurrent run, or a
 * value already recorded for that date, hits the live-value unique index
 * (P2002) and counts as already recorded. Each row is written with its audit
 * entry and the loan-admin bell items in one transaction. Every query passes
 * tenantId explicitly: a cron has no tenant frame (lib/tenant-scope.ts).
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAudit, logAuditStrict } from "@/lib/audit"
import { dbDate, isoOfDbDate } from "./dates"
import { alertLoanAdmins } from "./reprice-notice"
import { fetchSarbObservations, type FeedBasis, type SarbFeedError, type SarbFeedResult, type SarbObservation } from "./sarb-rate-feed"

type SyncDb = Pick<typeof prisma, "tenantConfig" | "referenceRate" | "user" | "notification" | "auditLog" | "$transaction">

export const FEED_ACTOR_EMAIL = "system@sarb-rate-feed"

/** ZARONIA is recorded only when it differs from the latest live value by at least this (25 bp). */
export const ZARONIA_MIN_MOVE = new Prisma.Decimal("0.0025")

export type FeedSkip = "unchanged" | "below_threshold" | "stale" | "already_pending" | "already_recorded"

export interface RecordedRate {
  id: string
  basis: FeedBasis
  effectiveDate: string
  rate: string
}

export interface TenantFeedRun {
  tenantId: string
  recorded: RecordedRate[]
  skipped: Partial<Record<FeedSkip, number>>
  failed: number
}

export type RateFeedRun =
  | { ok: true; perTenant: TenantFeedRun[] }
  | { ok: false; reason: "feed_unavailable"; feed: SarbFeedError }
  | { ok: false; reason: "tenant_failed"; perTenant: TenantFeedRun[] }

interface LiveValue {
  rate: Prisma.Decimal
  effectiveDate: Date
}

/** Why an observation is not recorded against the latest live value, or null if it should be. */
export function feedSkipReason(latest: LiveValue | null, observation: SarbObservation): Exclude<FeedSkip, "already_pending" | "already_recorded"> | null {
  if (!latest) return null
  if (latest.rate.equals(observation.rate)) return "unchanged"
  if (observation.basis === "ZARONIA" && latest.rate.minus(observation.rate).abs().lessThan(ZARONIA_MIN_MOVE)) return "below_threshold"
  if (observation.effectiveDate < isoOfDbDate(latest.effectiveDate)) return "stale"
  return null
}

const percentText = (rate: Prisma.Decimal): string => `${rate.mul(100).toFixed(Math.max(2, rate.mul(100).decimalPlaces()))}%`

async function recordObservation(db: SyncDb, tenantId: string, observation: SarbObservation): Promise<RecordedRate | "already_recorded"> {
  const { basis, effectiveDate, rate } = observation
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.referenceRate.create({
        data: { tenantId, basis, effectiveDate: dbDate(effectiveDate), rate, source: "SARB_FEED" },
      })
      await logAuditStrict({
        tenantId,
        userEmail: FEED_ACTOR_EMAIL,
        action: AuditAction.REFERENCE_RATE_RECORDED,
        entity: "ReferenceRate",
        entityId: row.id,
        newValue: { basis, effectiveDate, rate: row.rate.toString(), status: row.status, source: row.source, timeseriesCode: observation.timeseriesCode },
      }, tx)
      await alertLoanAdmins(tx, tenantId, {
        type: "REFERENCE_RATE_FEED_PENDING",
        title: `SARB feed: ${basis} ${percentText(row.rate)} from ${effectiveDate} awaits approval`,
        body: `The Reserve Bank feed shows a new ${basis} value. It is recorded PENDING: a user with the decide permission approves or rejects it on the Reference rates page, and no loan reprices on it until then.`,
        entityType: "ReferenceRate",
        entityId: row.id,
      })
      return { id: row.id, basis, effectiveDate, rate: row.rate.toString() }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "already_recorded"
    throw error
  }
}

async function syncTenant(db: SyncDb, tenantId: string, observations: SarbObservation[]): Promise<TenantFeedRun> {
  const run: TenantFeedRun = { tenantId, recorded: [], skipped: {}, failed: 0 }
  const skip = (reason: FeedSkip) => { run.skipped[reason] = (run.skipped[reason] ?? 0) + 1 }
  for (const observation of observations) {
    try {
      const { basis, rate } = observation
      const latest = await db.referenceRate.findFirst({
        where: { tenantId, basis, status: { in: ["APPROVED", "PENDING"] } },
        orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
        select: { rate: true, effectiveDate: true },
      })
      const reason = feedSkipReason(latest, observation)
      if (reason) { skip(reason); continue }
      const waiting = await db.referenceRate.findFirst({
        where: { tenantId, basis, status: "PENDING", source: "SARB_FEED", rate },
        select: { id: true },
      })
      if (waiting) { skip("already_pending"); continue }
      const outcome = await recordObservation(db, tenantId, observation)
      if (outcome === "already_recorded") skip("already_recorded")
      else run.recorded.push(outcome)
    } catch (error) {
      run.failed++
      console.error("[reference-rate-feed] recording failed", { tenantId, basis: observation.basis, effectiveDate: observation.effectiveDate, error })
    }
  }
  return run
}

/** Records `observations` for every tenant with asset finance on. */
export async function syncReferenceRatesFromFeed(db: SyncDb, observations: SarbObservation[]): Promise<TenantFeedRun[]> {
  const tenants = await db.tenantConfig.findMany({
    where: { featureAssetFinance: true },
    orderBy: { tenantId: "asc" },
    select: { tenantId: true },
  })
  const perTenant: TenantFeedRun[] = []
  for (const tenant of tenants) perTenant.push(await syncTenant(db, tenant.tenantId, observations))
  return perTenant
}

/**
 * One feed run: fetch, then sync. A feed that cannot be read is audited
 * (REFERENCE_RATE_FEED_FAILED, no tenant) and logged, and nothing is recorded.
 */
export async function runReferenceRateFeed(db: SyncDb, fetchFeed: () => Promise<SarbFeedResult> = fetchSarbObservations): Promise<RateFeedRun> {
  const feed = await fetchFeed()
  if (!feed.ok) {
    console.error("[reference-rate-feed] feed unavailable", { reason: feed.reason, detail: feed.detail })
    await logAudit({
      userEmail: FEED_ACTOR_EMAIL,
      action: AuditAction.REFERENCE_RATE_FEED_FAILED,
      entity: "ReferenceRateFeed",
      newValue: { reason: feed.reason, detail: feed.detail },
    })
    return { ok: false, reason: "feed_unavailable", feed }
  }
  const perTenant = await syncReferenceRatesFromFeed(db, feed.observations)
  if (perTenant.some((run) => run.failed > 0)) return { ok: false, reason: "tenant_failed", perTenant }
  return { ok: true, perTenant }
}
