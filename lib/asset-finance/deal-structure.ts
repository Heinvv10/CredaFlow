/**
 * A deal's structure, solved: the bridge between the stored deal terms (or a
 * preview request) and the pure solver (./structure.ts).
 *
 * START DATE. The deal has no contract start until it is booked (the payout
 * date, slice 1 item 4.10). Origination solves an INDICATIVE schedule from a
 * start one month before firstDueDate: dealStartDate(firstDueDate). That is
 * the solver's own convention (first due = start + 1 month), and it makes the
 * schedule reproducible from the stored columns alone. Booking re-solves from
 * the actual payout date.
 *
 * RATE. FIXED: the deal's fixedRate. A reference basis: the tenant's
 * ReferenceRate for that basis in effect on the start date (the latest on or
 * before it) plus the deal's margin, computed in Decimal. The result must be
 * from 0 to 1 (CHECK ContractRate_resulting_rate_range at booking). The path
 * has one point, effective on the start date. A schedule read later uses the
 * reference in effect on the start date at that time.
 *
 * CASH PRICE is the asset's cash price excluding VAT plus its VAT: the amount
 * the supplier is paid. A VAT-deferral period repays the asset's VAT as a
 * lump in that period.
 */
import { Prisma } from "@prisma/client"
import { addMonthsClamped, toDayNumber } from "./dates"
import { MAX_INT } from "./input-fields"
import { referenceRateOn, type RatesDb } from "./rates-store"
import { solveStructure } from "./structure"
import type { RateTerms, StructureTerms } from "./deal-input"
import type { StructureResult } from "./types"

export interface AssetPrice {
  cashPriceExclVatCents: number
  vatCents: number
}

export interface ResolvedRate {
  annualRate: string // decimal string
  reference: { effectiveDate: string; rate: string } | null
}

export type Solved = { ok: true; rate: ResolvedRate; startDate: string; result: StructureResult; termDays: number } | { ok: false; error: string }

export function dealStartDate(firstDueDate: string): string {
  return addMonthsClamped(firstDueDate, -1)
}

export async function resolveRate(
  db: RatesDb,
  tenantId: string,
  rate: RateTerms,
  startDate: string,
): Promise<ResolvedRate | { error: string }> {
  if (rate.basis === "FIXED") {
    if (rate.fixedRate === null) return { error: "A fixed rate needs fixedRate" }
    return { annualRate: new Prisma.Decimal(rate.fixedRate).toString(), reference: null }
  }
  if (rate.margin === null) return { error: "A reference-linked rate needs a margin" }
  const reference = await referenceRateOn(db, tenantId, rate.basis, startDate)
  if (!reference) return { error: `No ${rate.basis} reference rate is recorded on or before ${startDate}` }
  const resulting = reference.rate.add(new Prisma.Decimal(rate.margin))
  if (resulting.lessThan(0) || resulting.greaterThanOrEqualTo(1)) {
    return { error: `${rate.basis} ${reference.rate.toString()} plus margin ${rate.margin} is outside 0 to 1` }
  }
  return {
    annualRate: resulting.toString(),
    reference: { effectiveDate: reference.effectiveDate, rate: reference.rate.toString() },
  }
}

/** Solve a structure for an asset at a resolved rate; solver refusals come back as `error`. */
export function solveDealStructure(asset: AssetPrice, terms: StructureTerms, rate: ResolvedRate): Solved {
  const startDate = dealStartDate(terms.firstDueDate)
  let result: StructureResult
  try {
    result = solveStructure({
      cashPriceCents: asset.cashPriceExclVatCents + asset.vatCents,
      depositCents: terms.depositCents,
      tradeInCents: terms.tradeInCents,
      financedFeesCents: terms.financedFeesCents,
      balloonCents: terms.balloonCents,
      vatDeferralPeriods:
        terms.vatDeferralPeriodIndex === null
          ? undefined
          : { vatCents: asset.vatCents, periodIndex: terms.vatDeferralPeriodIndex },
      weights: terms.weights,
      startDate,
      firstDueDate: terms.firstDueDate,
      ratePath: [{ effectiveDate: startDate, annualRate: Number(rate.annualRate) }],
    })
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: error.message }
    throw error
  }
  // The application and deal columns are INT4.
  if (result.financedAmountCents > MAX_INT || result.baseInstalmentCents > MAX_INT) {
    return { ok: false, error: "The financed amount or instalment is too large" }
  }
  const lastDue = result.rows[result.rows.length - 1].dueDate
  return { ok: true, rate, startDate, result, termDays: toDayNumber(lastDue) - toDayNumber(startDate) }
}

/** resolveRate then solveDealStructure. */
export async function solveWithRate(
  db: RatesDb,
  tenantId: string,
  asset: AssetPrice,
  terms: StructureTerms,
): Promise<Solved> {
  const rate = await resolveRate(db, tenantId, terms.rate, dealStartDate(terms.firstDueDate))
  if ("error" in rate) return { ok: false, error: rate.error }
  return solveDealStructure(asset, terms, rate)
}
