/**
 * What booking writes for a deal, computed from the solved structure. Pure:
 * no database, no clock (./booking.ts writes it).
 *
 * SCHEDULE. One RepaymentSchedule row per solver row via toScheduleRecord
 * (./schedule-records.ts, which states the stored representation and its
 * invariants). The loan's totals are the rows' sums, so every consumer's
 * reconciliation holds:
 *   principal = Σ principalDue (= F + capitalised interest)
 *   totalInterest = Σ interestDue
 *   totalRepayable = Σ totalDue
 *   outstandingPrincipal = principal (nothing is paid at booking)
 *
 * INTEREST MODEL: REDUCING_BALANCE. The ledger code treats a
 * REDUCING_BALANCE loan's stored schedule as the contract: settlement is the
 * schedule total less what is paid (lib/loan/settlement.ts) and the rate is
 * annualised as interestRatePm × 12 (lib/loan/annualised-rate.ts), which is
 * the solver's nominal annual rate when interestRatePm = annual / 12.
 * DAILY_ACCRUAL would annualise as (rate / 30) × 365 (overstating by
 * 365/360) and carries the consumer bullet-row early-settlement rewrite.
 * The repricing fixture books the same way (reprice.integration-fixture.ts).
 *
 * CONTRACTUAL TOTALS ARE LEFT NULL. Every reader falls back to the live
 * totals (`contractualTotalRepayable ?? totalRepayable`: settlement, payment
 * reversal, book-as-of, bureau inputs). Repricing (./reprice-loan.ts) moves
 * totalInterest and totalRepayable by the change in the pending rows and
 * leaves contractual* alone; a contractual total fixed at booking would make
 * settlement and reversal read the pre-repricing figure. The booking
 * figures are in the ASSET_DEAL_BOOKED audit row and the ContractRate row.
 *
 * INT4. Every money column written is a Postgres INTEGER; a value above
 * INT4_MAX is refused here with the field named, before any write.
 */
import { INT4_MAX } from "@/lib/product-config/bounds"
import { dueDateInstant, toScheduleRecord, type ScheduleRecordAmounts } from "./schedule-records"
import type { StructureResult } from "./types"

export interface BookingPlanInput {
  result: StructureResult
  startDate: string // YYYY-MM-DD, SAST calendar day the loan starts (the payout date)
  balloonCents: number
  payoutCents: number
}

export interface BookingPlan {
  records: ScheduleRecordAmounts[]
  principal: number
  totalInterest: number
  totalRepayable: number
  baseInstalmentCents: number
  startDate: Date
  maturityDate: Date
  nextPaymentDate: Date | null
}

export class BookingAmountError extends RangeError {
  constructor(readonly field: string, readonly value: number) {
    super(`${field} (${value} cents) does not fit the ledger's 32-bit money columns (at most ${INT4_MAX} cents)`)
    this.name = "BookingAmountError"
  }
}

function fits(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > INT4_MAX) throw new BookingAmountError(field, value)
}

export function planBooking(input: BookingPlanInput): BookingPlan {
  const { result } = input
  const records = result.rows.map(toScheduleRecord)
  const sum = (pick: (r: ScheduleRecordAmounts) => number) => records.reduce((total, r) => total + pick(r), 0)
  const plan: BookingPlan = {
    records,
    principal: sum((r) => r.principalDue),
    totalInterest: sum((r) => r.interestDue),
    totalRepayable: sum((r) => r.totalDue),
    baseInstalmentCents: result.baseInstalmentCents,
    startDate: dueDateInstant(input.startDate),
    maturityDate: records[records.length - 1].dueDate,
    nextPaymentDate: records.find((r) => r.totalDue > 0)?.dueDate ?? null,
  }
  fits("principal", plan.principal)
  fits("totalInterest", plan.totalInterest)
  fits("totalRepayable", plan.totalRepayable)
  fits("base instalment", plan.baseInstalmentCents)
  fits("balloon", input.balloonCents)
  fits("payout", input.payoutCents)
  fits("financed amount", result.financedAmountCents)
  records.forEach((r) => {
    for (const [field, value] of [["principalDue", r.principalDue], ["interestDue", r.interestDue], ["totalDue", r.totalDue]] as const) {
      fits(`instalment ${r.installmentNo} ${field}`, value)
    }
  })
  return plan
}
