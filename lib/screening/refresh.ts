import type { AppStatus, LoanStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { RESCREEN_BATCH_LIMIT, screeningCutoff } from "./policy"
import { runScreening } from "./run"

/** A client is in an ongoing relationship while a loan or an application is live. */
export const RESCREEN_LOAN_STATUSES: LoanStatus[] = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]
export const RESCREEN_APPLICATION_STATUSES: AppStatus[] = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"]

export type RefreshResult = {
  candidates: number
  screened: number
  /** Runs that ended REFER or BLOCKED: now in the review queue or stopped. */
  flagged: number
  /** Runs that recorded a provider error, plus runs that threw. */
  failed: number
  errors: string[]
}

/**
 * Periodic re-screen for one tenant: active clients with no screening run in
 * the last SCREENING_MAX_AGE_DAYS, oldest first by client creation, at most
 * RESCREEN_BATCH_LIMIT per call. Deceased clients are skipped. Each run is
 * audited by runScreening; the caller reports the totals.
 */
export async function refreshTenantScreening(tenantId: string, now: Date = new Date()): Promise<RefreshResult> {
  const cutoff = screeningCutoff(now)
  const clients = await prisma.client.findMany({
    where: {
      tenantId,
      deceasedAt: null,
      screeningChecks: { none: { createdAt: { gte: cutoff } } },
      OR: [
        { loans: { some: { status: { in: RESCREEN_LOAN_STATUSES } } } },
        { applications: { some: { status: { in: RESCREEN_APPLICATION_STATUSES } } } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: RESCREEN_BATCH_LIMIT,
  })

  const result: RefreshResult = { candidates: clients.length, screened: 0, flagged: 0, failed: 0, errors: [] }
  for (const { id } of clients) {
    try {
      const ran = await runScreening({ tenantId, clientId: id, trigger: "PERIODIC", actor: null })
      if (!ran.configured) break
      result.screened++
      if (ran.state.state === "REFER" || ran.state.state === "BLOCKED") result.flagged++
      if (ran.providerError) result.failed++
    } catch (error) {
      result.failed++
      result.errors.push(`${id}: ${error instanceof Error ? error.name : typeof error}`)
    }
  }
  return result
}
