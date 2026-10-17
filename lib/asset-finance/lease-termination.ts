/**
 * The early-termination amount of an operating or full-maintenance lease
 * (slice 3, C8; goal 2a.4). Pure.
 *
 *   amount = PV of the rental-only portions still to fall due (maintenance
 *            and VAT excluded), discounted at the contract rate
 *          + the penalty: penaltyRate × that PV, half-up
 *          + the arrears (rentals and charges already due and unpaid).
 * The asset comes back; no credit is given for its resale value.
 * // Formula and penalty (CPA Reg 5 "reasonable"): signed off by the lender's legal team, 2026-10-17.
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
 * VAT half-up per line. // The VAT treatment of a termination amount is
 * signed off by the lender's tax adviser, 2026-10-17. The arrears are already invoiced rentals: no new VAT.
 *
 * CPA s14: a consumer may cancel a fixed-term agreement on 20 business days'
 * notice; the termination date is then the notice date plus 20 South African
 * business days (cpaCancellationDate). // Signed off by the lender's legal team, 2026-10-17.
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
