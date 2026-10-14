/**
 * When a lease's fixed term ends (slice 3, C7), and the valuations a purchase
 * may rest on. The database repeats both (guardLeaseEndOfTerm).
 *
 * The term ends with its last uncancelled rental: on that rental's due date
 * in arrears, a month later in advance (that rental pays for the last month).
 * A return is inspected, and a purchase sale-invoiced, only from then; an
 * early termination's return from its termination date.
 *
 * A purchase rests on market value: a valuation by an ASSESSOR or a DEALER
 * (never INTERNAL, never an AUCTIONEER's forced-sale figure), dated within
 * TenantConfig.leasePurchaseValuationMaxAgeDays, recorded by someone other
 * than the staff member who elects. // UNTESTED: tax/legal.
 */
import type { ValuationSource } from "@prisma/client"
import { addMonthsClamped, dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import type { SigningTx } from "./signing-prepare"

export const MARKET_VALUATION_SOURCES: readonly ValuationSource[] = ["ASSESSOR", "DEALER"]

/** The day the lease's fixed term (or an extension's rentals) ends, or null with no rentals. */
export async function leaseTermEnd(tx: SigningTx, tenantId: string, loanId: string): Promise<string | null> {
  const last = await tx.leaseRental.findFirst({ where: { tenantId, loanId, cancelledAt: null }, orderBy: { periodNo: "desc" }, select: { dueDate: true } })
  if (!last) return null
  const deal = await tx.assetFinanceDeal.findFirst({ where: { tenantId, loanId }, select: { rentalTiming: true } })
  const due = isoOfDbDate(last.dueDate)
  return deal?.rentalTiming === "ADVANCE" ? addMonthsClamped(due, 1) : due
}

export async function purchaseMaxAgeDays(tx: SigningTx, tenantId: string): Promise<number> {
  const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { leasePurchaseValuationMaxAgeDays: true } })
  return config?.leasePurchaseValuationMaxAgeDays ?? 30
}

export type ValuationCheck = { ok: true; amountCents: number } | { ok: false; reason: string; error: string }

/** A valuation a purchase may rest on, on `today`, elected by `electorUserId` (null for the lessee in the portal). */
export async function checkPurchaseValuation(
  tx: SigningTx,
  input: { tenantId: string; assetId: string; valuationId: string; today: string; electorUserId: string | null },
): Promise<ValuationCheck> {
  const valuation = await tx.assetValuation.findFirst({
    where: { id: input.valuationId, tenantId: input.tenantId, assetId: input.assetId },
    select: { valuedOn: true, amountCents: true, source: true, createdById: true },
  })
  if (!valuation) return { ok: false, reason: "valuation", error: "The valuation is not of this asset" }
  if (!MARKET_VALUATION_SOURCES.includes(valuation.source)) return { ok: false, reason: "valuation_source", error: "A purchase rests on an assessor's or a dealer's valuation" }
  if (input.electorUserId !== null && valuation.createdById === input.electorUserId) {
    return { ok: false, reason: "valuation_four_eyes", error: "The valuation must be recorded by someone other than the person who elects the purchase" }
  }
  const maxAge = await purchaseMaxAgeDays(tx, input.tenantId)
  if (toDayNumber(isoOfDbDate(valuation.valuedOn)) < toDayNumber(input.today) - maxAge) return { ok: false, reason: "valuation_stale", error: `The valuation must be dated within ${maxAge} days` }
  return { ok: true, amountCents: valuation.amountCents }
}

/** The highest current market valuation of the asset (the portal's purchase price), or null. */
export async function bestMarketValuation(tx: SigningTx, tenantId: string, assetId: string, today: string): Promise<{ id: string; amountCents: number } | null> {
  const maxAge = await purchaseMaxAgeDays(tx, tenantId)
  return tx.assetValuation.findFirst({
    where: { tenantId, assetId, source: { in: [...MARKET_VALUATION_SOURCES] }, valuedOn: { gte: dbDate(fromDayNumber(toDayNumber(today) - maxAge)) } },
    orderBy: [{ amountCents: "desc" }, { valuedOn: "desc" }],
    select: { id: true, amountCents: true },
  })
}
