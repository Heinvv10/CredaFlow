/**
 * The repricing sweep behind app/api/cron/asset-finance-reprice. For every
 * tenant with featureAssetFinance on, for every APPROVED ReferenceRate
 * effective on or before `day` (oldest first, so successive changes apply in
 * order; a PENDING or REJECTED value never reprices), it
 * reprices each ACTIVE asset-finance loan that holds a contract rate on that
 * basis from an earlier date and none from that date yet.
 *
 * Each loan runs in its own transaction: one failure is logged and counted
 * and the sweep goes on. A loan already repriced for a date has a
 * ContractRate row on it and is not selected again, so re-running the sweep
 * changes nothing. `day` is also the run date the notice window counts from
 * (./reprice.ts REPRICE_NOTICE_DAYS). Every query passes tenantId explicitly:
 * a cron has no tenant frame (lib/tenant-scope.ts).
 */
import type { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "./dates"
import { repriceLoanForReference, type NotEligibleReason } from "./reprice-loan"

type BatchDb = Pick<typeof prisma, "tenantConfig" | "referenceRate" | "loan" | "$transaction">

export interface TenantRepriceRun {
  tenantId: string
  repriced: number
  alreadyRepriced: number
  notEligible: Partial<Record<NotEligibleReason, number>>
  failed: number
}

export interface RepriceBatchRun {
  ok: boolean
  day: string
  perTenant: TenantRepriceRun[]
}

async function runTenant(db: BatchDb, tenantId: string, day: string): Promise<TenantRepriceRun> {
  const run: TenantRepriceRun = { tenantId, repriced: 0, alreadyRepriced: 0, notEligible: {}, failed: 0 }
  const failedLoanIds = new Set<string>()
  const references = await db.referenceRate.findMany({
    where: { tenantId, status: "APPROVED", effectiveDate: { lte: dbDate(day) } },
    orderBy: [{ effectiveDate: "asc" }, { basis: "asc" }],
    select: { basis: true, effectiveDate: true },
  })
  for (const reference of references) {
    const loans = await db.loan.findMany({
      where: {
        tenantId,
        status: { in: ["ACTIVE", "COMPLETED"] },
        contractType: { not: "LOAN" },
        contractRates: {
          some: { basis: reference.basis, effectiveDate: { lt: reference.effectiveDate } },
          none: { effectiveDate: reference.effectiveDate },
        },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    })
    const effectiveDate = isoOfDbDate(reference.effectiveDate)
    for (const loan of loans) {
      // Preserve effective-date order for each loan. Applying a later change
      // after an earlier one failed would make the missing change superseded
      // on retry, permanently dropping it from the contract-rate history.
      if (failedLoanIds.has(loan.id)) continue
      try {
        const outcome = await db.$transaction((tx) =>
          repriceLoanForReference(tx, { tenantId, loanId: loan.id, basis: reference.basis, effectiveDate, runDate: day }),
        )
        if (outcome.kind === "repriced") run.repriced++
        else if (outcome.kind === "already_repriced") run.alreadyRepriced++
        else run.notEligible[outcome.reason] = (run.notEligible[outcome.reason] ?? 0) + 1
      } catch (error) {
        failedLoanIds.add(loan.id)
        run.failed++
        console.error("[asset-finance-reprice] loan failed", { tenantId, loanId: loan.id, basis: reference.basis, effectiveDate, error })
      }
    }
  }
  return run
}

export async function runRepriceBatch(db: BatchDb, day: string): Promise<RepriceBatchRun> {
  const tenants = await db.tenantConfig.findMany({
    where: { featureAssetFinance: true },
    orderBy: { tenantId: "asc" },
    select: { tenantId: true },
  })
  const perTenant: TenantRepriceRun[] = []
  for (const tenant of tenants) perTenant.push(await runTenant(db, tenant.tenantId, day))
  return { ok: perTenant.every((run) => run.failed === 0), day, perTenant }
}
