/**
 * The nightly sweep of one lender's variable-rate loans: every approved reference value effective by `today` and after the one
 * the loan is on, oldest first, so successive changes apply in order. Each loan-and-value runs in its own transaction: a
 * failure is logged and counted, stops that loan (a later value applied over a missing one would drop it for good) and the
 * sweep goes on. A second run finds nothing new.
 */
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import { prisma } from "@/lib/prisma"
import { repriceLoan } from "./reprice-loan"
import type { VariableRateBasis } from "./types"
import { VARIABLE_RATE_BASES } from "./types"

export interface TenantRepriceRun {
  repriced: number
  alreadyRepriced: number
  unchanged: number
  noRows: number
  notEligible: number
  failed: number
}

export async function repriceTenantLoans(tenantId: string, today: string): Promise<TenantRepriceRun> {
  const run: TenantRepriceRun = { repriced: 0, alreadyRepriced: 0, unchanged: 0, noRows: 0, notEligible: 0, failed: 0 }
  const references = await prisma.referenceRate.findMany({
    where: { tenantId, status: "APPROVED", basis: { in: [...VARIABLE_RATE_BASES] }, effectiveDate: { lte: dbDate(today) } },
    orderBy: { effectiveDate: "asc" },
    select: { basis: true, effectiveDate: true, rate: true },
  })
  if (references.length === 0) return run
  const loans = await prisma.loan.findMany({
    where: { tenantId, status: "ACTIVE", terms: { some: { rateBasis: { not: null } } } },
    orderBy: { id: "asc" },
    select: { id: true, terms: { orderBy: { sequence: "desc" }, take: 1, select: { rateBasis: true, referenceEffectiveDate: true } } },
  })
  for (const loan of loans) {
    const last = loan.terms[0]
    if (!last?.rateBasis || !last.referenceEffectiveDate) continue
    const after = last.referenceEffectiveDate.getTime()
    for (const row of references.filter((r) => r.basis === last.rateBasis && r.effectiveDate.getTime() > after)) {
      const reference = { rate: row.rate.toNumber(), effectiveDate: isoOfDbDate(row.effectiveDate) }
      try {
        const outcome = await prisma.$transaction((tx) => repriceLoan(tx, { tenantId, loanId: loan.id, basis: row.basis as VariableRateBasis, reference, today }))
        if (outcome.kind === "repriced") run.repriced++
        else if (outcome.kind === "already_repriced") run.alreadyRepriced++
        else if (outcome.kind === "unchanged") run.unchanged++
        else if (outcome.kind === "no_rows") run.noRows++
        else run.notEligible++
      } catch (error) {
        run.failed++
        console.error("[loan-rate-reprice] loan failed", { tenantId, loanId: loan.id, effectiveDate: reference.effectiveDate, error: error instanceof Error ? error.message : String(error) })
        break
      }
    }
  }
  return run
}
