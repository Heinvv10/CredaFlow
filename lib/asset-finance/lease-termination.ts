/**
 * The early-termination amount of an operating or full-maintenance lease
 * (slice 3, C8; goal 2a.4). Pure.
 *
 *   amount = PV of the rental-only portions still to fall due (maintenance
 *            and VAT excluded), discounted at the contract rate
 *          + the penalty: penaltyRate × that PV, half-up
 *          + the arrears (rentals and charges already due and unpaid).
 * The asset comes back; no credit is given for its resale value.
 * This percentage formula applies to commercial lessees only. CPA cancellation
 * instead uses cpaCancellationCharge below: goods credit and documented costs,
 * without a percentage penalty (changed 2026-10-17, DESIGN.md sign-off record).
 *
 * PRESENT VALUE. A rental due after the termination date is discounted back
 * period by period with the solver's own convention (actual/365, simple
 * within a period): the rental due on d_k is divided by
 * Π_{j ≤ k} (1 + r × days_j / 365), days_1 counted from the termination date
 * to the first remaining due date. Summed unrounded, rounded half-up once. A
 * rental due on or before the termination date is not "still to fall due":
 * it is in the arrears (or paid).
 *
 * VAT. The PV and the penalty are invoiced on one tax invoice, a line each,
 * VAT half-up per line. The VAT treatment of a termination amount is
 * signed off (see DESIGN.md sign-off record 2026-10-17). The arrears are already invoiced rentals: no new VAT.
 *
 * CPA s14: a consumer may cancel a fixed-term agreement on 20 business days'
 * notice; the termination date is then the notice date plus 20 South African
 * business days (cpaCancellationDate). Signed off (see DESIGN.md sign-off record 2026-10-17).
 */
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { DAY_COUNT_BASIS } from "./amortise"
import { toDayNumber } from "./dates"
import { decimal6, WEIGHT_SCALE } from "./lease-pricing"

export const CPA_CANCELLATION_NOTICE_BUSINESS_DAYS = 20

export interface RentalDue {
  dueDate: string
  rentalExclVatCents: number
}

export function presentValueOfRentals(rentals: readonly RentalDue[], terminationDate: string, annualRate: number): number {
  if (!Number.isFinite(annualRate) || annualRate < 0) throw new RangeError("annualRate: must be a finite decimal >= 0")
  let previous = toDayNumber(terminationDate, "terminationDate")
  let factor = 1
  let pv = 0
  for (const rental of [...rentals].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    const due = toDayNumber(rental.dueDate, "dueDate")
    if (due <= toDayNumber(terminationDate)) continue
    factor *= 1 + (annualRate * (due - previous)) / DAY_COUNT_BASIS
    pv += rental.rentalExclVatCents / factor
    previous = due
  }
  return Math.round(pv)
}

export interface TerminationInput {
  rentals: readonly RentalDue[]
  terminationDate: string
  annualRate: number
  arrearsCents: number
  /** Decimal string, at most 6 places (DECIMAL(9,6)). */
  penaltyRate: string
  vatRateTenThousandths: number
}

export interface TerminationAmount {
  remainingRentals: number
  pvCents: number
  penaltyCents: number
  arrearsCents: number
  invoiceExclVatCents: number
  invoiceVatCents: number
  totalCents: number
}

export function earlyTerminationAmount(input: TerminationInput): TerminationAmount {
  if (!Number.isSafeInteger(input.arrearsCents) || input.arrearsCents < 0) throw new RangeError("arrearsCents: must be a non-negative integer")
  const pvCents = presentValueOfRentals(input.rentals, input.terminationDate, input.annualRate)
  const rate = decimal6(input.penaltyRate, "penaltyRate")
  const scale = BigInt(WEIGHT_SCALE)
  const penaltyCents = Number((BigInt(pvCents) * rate * BigInt(2) + scale) / (scale * BigInt(2)))
  const invoiceVatCents = vatOnExclusive(pvCents, input.vatRateTenThousandths) + vatOnExclusive(penaltyCents, input.vatRateTenThousandths)
  const day = toDayNumber(input.terminationDate)
  return {
    remainingRentals: input.rentals.filter((r) => toDayNumber(r.dueDate) > day).length,
    pvCents,
    penaltyCents,
    arrearsCents: input.arrearsCents,
    invoiceExclVatCents: pvCents + penaltyCents,
    invoiceVatCents,
    totalCents: pvCents + penaltyCents + invoiceVatCents + input.arrearsCents,
  }
}

/** The CPA s14 termination date for a consumer's cancellation notice given on `noticeDate`. */
export function cpaCancellationDate(noticeDate: string): string {
  return addSouthAfricanBusinessDays(noticeDate, CPA_CANCELLATION_NOTICE_BUSINESS_DAYS)
}

export interface CancellationCost {
  description: string
  amountCents: number
  /** File/document reference for the actual recovery, refurbishment or re-letting cost. */
  evidence: string
  /** Evidence confirming this cost was not deducted in the net goods valuation. */
  valuationNoOverlapEvidence?: string
}

function nonNegativeCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field}: non-negative integer cents required`)
}

/** CPA s14(3)(b)(ii), Reg 5(2): actual loss, crediting the returned goods. */
export function cpaCancellationCharge(input: {
  rentals: readonly RentalDue[]; terminationDate: string; annualRate: number
  goodsValueCents: number; costs: readonly CancellationCost[]
}): { pvCents: number; goodsValueCents: number; costsCents: number; chargeCents: number } {
  nonNegativeCents(input.goodsValueCents, "goodsValueCents")
  let costsCents = 0
  for (const cost of input.costs) {
    nonNegativeCents(cost.amountCents, "cost.amountCents")
    if (!cost.description.trim() || !cost.evidence.trim()) throw new RangeError("Every actual cost needs its description and evidence")
    costsCents += cost.amountCents
  }
  nonNegativeCents(costsCents, "costsCents")
  const remaining = input.rentals.filter((r) => r.dueDate > input.terminationDate)
  const undiscounted = remaining.reduce((sum, r) => sum + r.rentalExclVatCents, 0)
  const pvCents = presentValueOfRentals(remaining, input.terminationDate, input.annualRate)
  return { pvCents, goodsValueCents: input.goodsValueCents, costsCents,
    chargeCents: Math.max(0, Math.min(pvCents - input.goodsValueCents + costsCents, undiscounted - 1)) }
}

/** A write-off ends the lease: arrears + PV, no penalty, less insurance actually received. */
export function totalLossAmount(input: {
  rentals: readonly RentalDue[]; terminationDate: string; annualRate: number
  arrearsCents: number; insuranceProceedsCents: number
}): { pvCents: number; totalCents: number } {
  nonNegativeCents(input.arrearsCents, "arrearsCents")
  nonNegativeCents(input.insuranceProceedsCents, "insuranceProceedsCents")
  const pvCents = presentValueOfRentals(input.rentals, input.terminationDate, input.annualRate)
  return { pvCents, totalCents: Math.max(0, input.arrearsCents + pvCents - input.insuranceProceedsCents) }
}
