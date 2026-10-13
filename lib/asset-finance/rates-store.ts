/**
 * Reads of the dated rate tables (DESIGN.md D4): a tenant's ReferenceRate
 * values and a loan's ContractRate history. Both effectiveDate columns are
 * Postgres DATEs (./dates.ts dbDate / isoOfDbDate convert at that boundary).
 *
 * Only an APPROVED reference rate is a rate: a PENDING value awaits its second
 * approver and a REJECTED one never applied (four-eyes, migration
 * 20261013100000). Every query passes tenantId explicitly, so these work with
 * or without a tenant frame (lib/tenant-scope.ts; the repricing cron has none).
 */
import type { Prisma, ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "./dates"
import type { RatePoint } from "./types"

// Structural, so both the extended client and its transaction client fit.
export type RatesDb = Pick<typeof prisma, "referenceRate" | "contractRate">

export interface ReferenceRateValue {
  effectiveDate: string
  rate: Prisma.Decimal // annual nominal decimal, 0.1175 = 11.75%
}

/** The tenant's APPROVED `basis` rate in effect on `day`: the latest approved value effective on or before it. */
export async function referenceRateOn(
  db: RatesDb,
  tenantId: string,
  basis: ReferenceRateBasis,
  day: string,
): Promise<ReferenceRateValue | null> {
  const row = await db.referenceRate.findFirst({
    where: { tenantId, basis, status: "APPROVED", effectiveDate: { lte: dbDate(day) } },
    orderBy: { effectiveDate: "desc" },
    select: { effectiveDate: true, rate: true },
  })
  return row && { effectiveDate: isoOfDbDate(row.effectiveDate), rate: row.rate }
}

/** The loan's contract-rate history as a solver rate path, ascending by effective date. */
export async function contractRatePath(db: RatesDb, tenantId: string, loanId: string): Promise<RatePoint[]> {
  const rows = await db.contractRate.findMany({
    where: { tenantId, loanId },
    orderBy: { effectiveDate: "asc" },
    select: { effectiveDate: true, resultingRate: true },
  })
  return rows.map((row) => ({ effectiveDate: isoOfDbDate(row.effectiveDate), annualRate: row.resultingRate.toNumber() }))
}
