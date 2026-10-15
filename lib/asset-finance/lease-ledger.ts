/**
 * What booking writes for an operating or full-maintenance lease (slice 3,
 * C3), computed from the priced lease. Pure: no database, no clock.
 *
 * THE LEDGER MAPPING (DESIGN.md "Slice 3: lease ledger"). A lessee owes
 * rentals, not capital and interest: the finance charge inside a rental is
 * the lessor's pricing, never a separate debt, and the lessee never owes the
 * residual. So each rental's whole VAT-inclusive amount (rental +
 * maintenance + VAT) is ONE receivable:
 *   RepaymentSchedule: principalDue = totalDue = the rental's total incl. VAT;
 *                      interestDue = feesDue = creditLifePremiumDue = 0
 *   Loan.principal = Loan.totalRepayable = outstandingPrincipal = Σ totalDue
 *   Loan.totalInterest = 0; balloonAmount = null (guardLeaseDealBooking)
 * Receipts, bank sync, arrears (unpaid totalDue), reminders and statements
 * then read correct lease figures with no change: a receipt reduces the
 * rentals owed, arrears are unpaid rentals incl. VAT, and the statement lists
 * the rentals. NON_NCA default interest runs on overdue rentals
 * (./non-nca-charges.ts). The settlement readers (lib/loan/settlement.ts) are
 * unchanged: for a lease their figure is the rentals outstanding, what
 * prepaying every rental would cost (each is invoiced at receipt). Ending a
 * lease early is by quotation only (C8); screens label the figure as rentals
 * outstanding, and the NCA certificate of balance is refused for a lease.
 *
 * The capital pricing is kept for repricing: each row's
 * assetFinanceOpeningBalanceCents is the capital balance the rental's finance
 * charge accrued on (./lease-reprice.ts reads it back), and the LeaseRental
 * row (one per schedule row) holds the rental / maintenance / VAT split the
 * per-rental tax invoice prints.
 */
import { dbDate } from "./dates"
import { BookingAmountError } from "./booking-plan"
import { INT4_MAX } from "@/lib/product-config/bounds"
import { dueDateInstant, type ScheduleRecordAmounts } from "./schedule-records"
import type { LeasePricingResult } from "./lease-pricing"

export interface LeaseRentalRecord {
  periodNo: number
  dueDate: Date
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
  vatRate: string
}

export interface LeaseBookingPlan {
  records: ScheduleRecordAmounts[]
  openingBalances: number[]
  rentals: LeaseRentalRecord[]
  principal: number
  totalInterest: number
  totalRepayable: number
  baseInstalmentCents: number
  startDate: Date
  maturityDate: Date
  nextPaymentDate: Date | null
}

function fits(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > INT4_MAX) throw new BookingAmountError(field, value)
}

export function planLeaseBooking(input: { lease: LeasePricingResult; startDate: string; vatRate: string; payoutCents: number }): LeaseBookingPlan {
  const { lease } = input
  const records = lease.periods.map((p): ScheduleRecordAmounts => ({
    installmentNo: p.periodNo,
    dueDate: dueDateInstant(p.dueDate),
    principalDue: p.totalCents,
    interestDue: 0,
    feesDue: 0,
    creditLifePremiumDue: 0,
    totalDue: p.totalCents,
  }))
  const rentals = lease.periods.map((p): LeaseRentalRecord => ({
    periodNo: p.periodNo,
    dueDate: dbDate(p.dueDate),
    rentalExclVatCents: p.rentalExclVatCents,
    maintenanceExclVatCents: p.maintenanceExclVatCents,
    vatCents: p.vatCents,
    totalCents: p.totalCents,
    vatRate: input.vatRate,
  }))
  const total = records.reduce((sum, r) => sum + r.totalDue, 0)
  const plan: LeaseBookingPlan = {
    records,
    openingBalances: lease.periods.map((p) => p.row.openingBalanceCents),
    rentals,
    principal: total,
    totalInterest: 0,
    totalRepayable: total,
    baseInstalmentCents: lease.baseRentalCents,
    startDate: dueDateInstant(input.startDate),
    maturityDate: records[records.length - 1].dueDate,
    nextPaymentDate: records[0].dueDate,
  }
  fits("total rentals", total)
  fits("base rental", lease.baseRentalCents)
  fits("payout", input.payoutCents)
  fits("capital", lease.capitalCents)
  records.forEach((r) => fits(`rental ${r.installmentNo} total`, r.totalDue))
  return plan
}
