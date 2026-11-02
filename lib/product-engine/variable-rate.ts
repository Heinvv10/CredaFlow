/**
 * A variable rate: the lender's approved reference value (annual) + a margin (annual), divided by 12 for the monthly rate the
 * engine charges. A loan keeps its own margin, the distance between the rate it was priced at (a pricing rule included) and the
 * reference that day, so a discount survives every later move of the reference. Only an APPROVED ReferenceRate is a rate.
 */
import type { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import type { VariableRateBasis } from "./types"

export interface FrozenVariableRate {
  basis: VariableRateBasis
  marginPa: number
  /** The approved reference value the rate came from, annual decimal, and the day it took effect. */
  referenceRate: number
  referenceEffectiveDate: string
}

export interface ReferenceValue {
  rate: number
  effectiveDate: string
}

const round8 = (value: number) => Math.round(value * 1e8) / 1e8

/** The monthly rate of reference + margin, never below 0. */
export function rateFromReference(referenceRate: number, marginPa: number): number {
  return Math.max(0, round8((referenceRate + marginPa) / 12))
}

/** What a loan priced at `ratePm` off this reference keeps: its own margin. */
export function frozenVariableRate(basis: VariableRateBasis, reference: ReferenceValue, ratePm: number): FrozenVariableRate {
  return { basis, marginPa: round8(ratePm * 12 - reference.rate), referenceRate: reference.rate, referenceEffectiveDate: reference.effectiveDate }
}

/** The lender's approved `basis` value in effect on `day`, or null. */
export async function referenceOn(db: Pick<typeof prisma, "referenceRate">, tenantId: string, basis: VariableRateBasis, day: string): Promise<ReferenceValue | null> {
  const row = await db.referenceRate.findFirst({
    where: { tenantId, basis, status: "APPROVED", effectiveDate: { lte: dbDate(day) } },
    orderBy: { effectiveDate: "desc" },
    select: { effectiveDate: true, rate: true },
  })
  return row && { rate: row.rate.toNumber(), effectiveDate: isoOfDbDate(row.effectiveDate) }
}
