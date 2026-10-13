/**
 * Reads of the dated rate tables (DESIGN.md D4): a tenant's ReferenceRate
 * values and a loan's ContractRate history. Both effectiveDate columns are
 * Postgres DATEs, which Prisma reads and writes as UTC midnight; dbDate and
 * isoOfDbDate convert at that boundary.
 */
import type { Prisma, ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { toDayNumber } from "./dates"
import type { RatePoint } from "./types"

// Structural, so both the extended client and its transaction client fit.
export type RatesDb = Pick<typeof prisma, "referenceRate" | "contractRate">

/** The Date Prisma uses for a DATE column holding calendar day `iso`. */
export function dbDate(iso: string): Date {
  return new Date(toDayNumber(iso, "date") * 86_400_000)
}

export function isoOfDbDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export interface ReferenceRateValue {
  effectiveDate: string
  rate: Prisma.Decimal // annual nominal decimal, 0.1175 = 11.75%
}

/** The tenant's `basis` rate in effect on `day`: the latest value effective on or before it. */
export async function referenceRateOn(
  db: RatesDb,
  tenantId: string,
  basis: ReferenceRateBasis,
  day: string,
): Promise<ReferenceRateValue | null> {
  const row = await db.referenceRate.findFirst({
    where: { tenantId, basis, effectiveDate: { lte: dbDate(day) } },
    orderBy: { effectiveDate: "desc" },
    select: { effectiveDate: true, rate: true },
  })
  return row && { effectiveDate: isoOfDbDate(row.effectiveDate), rate: row.rate }
}

/** The loan's contract-rate history as a solver rate path, ascending by effective date. */
export async function contractRatePath(db: RatesDb, loanId: string): Promise<RatePoint[]> {
  const rows = await db.contractRate.findMany({
    where: { loanId },
    orderBy: { effectiveDate: "asc" },
    select: { effectiveDate: true, resultingRate: true },
  })
  return rows.map((row) => ({ effectiveDate: isoOfDbDate(row.effectiveDate), annualRate: row.resultingRate.toNumber() }))
}
